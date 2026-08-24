import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { app } from "electron"
import { VERIFIED_COMPLETION_POLICY } from "@opencode-ai/app/judge"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"
import { backupBeforeOverwrite } from "./workspace-checkpoint"

import {
  cancelBackgroundTask,
  createBackgroundTask,
  updateBackgroundTask,
  type BackgroundTaskStatus,
} from "./background-tasks"
import {
  classifyTaskDifficulty,
  contextBudgetForDifficulty,
  createContextBudgetPack,
  formatContextBudgetForAgent,
  type TaskDifficulty,
} from "./context-budget"
import { getStore } from "./store"
import { createPullRequest } from "./github"
import { runExternalCodingAgent, type CodingAgentRuntime } from "./external-agents"
import { claimPendingMessages, postTeamMessage, teamForWorkspace } from "./agent-teams"
import { formatDelivery, formatHandoff } from "./agent-team-model"
import { priorFor, recordValidationRun } from "./failure-memory"
import {
  formatValidationForRepair,
  validateWorkspace,
  type WorkspaceValidationReport,
} from "./workspace-guardrails"
import { parseUnifiedDiff, selectUnifiedDiff, type UnifiedDiffSelection } from "./unified-diff"
import { scanChangedSecrets } from "./secret-scanner"
import { spendLedger } from "./spend-limits"
import { parallelSessionCreateRequest } from "./parallel-session-scope"
import { repoRulesForPrompt } from "./repo-rules"
import { formatRulesForPrompt } from "./repo-rules-model"
import {
  appendTurn,
  continuationPrompt,
  extendStreamTail,
  settleRunningTurns,
  settleTurn,
  type ParallelWorkspaceTurn,
} from "./parallel-workspace-turns"

export type { ParallelWorkspaceTurn } from "./parallel-workspace-turns"

// Keep persisted metadata and isolated checkout directories on distinct paths.
// electron-store creates a file with STORE_NAME, so sharing that name with the
// workspace directory makes either the store or the checkout root unreadable.
const STORE_NAME = "parallel-workspaces-state"
const STORE_KEY = "records"
const WORKSPACE_DIRECTORY_NAME = "parallel-workspace-runs"

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".vercel",
])

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".yaml",
  ".yml",
])

export type ParallelWorkspaceStatus =
  | "queued"
  | "planning"
  | "editing"
  | "running commands"
  | "testing"
  | "complete"
  | "failed"
  | "needs review"
  | "stopped"
  | "merged"
  | "discarded"

export type ParallelWorkspaceRuntime = "vector" | CodingAgentRuntime

export type ParallelWorkspaceRecord = {
  id: string
  name: string
  taskPrompt: string
  runtime: ParallelWorkspaceRuntime
  provider: string
  model: string
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  isolatedPath: string
  isolation: "git-worktree" | "copy"
  gitBranch?: string
  baseCommit?: string
  agentSessionId?: string
  // The external CLI's own conversation id — codex thread_id, claude
  // session_id. Deliberately not agentSessionId: that field is engine-session
  // identity and drainTeamOutbox matches senders against it.
  externalSessionId?: string
  backgroundTaskId?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  // Whether this workspace's agent runs under the verified-completion policy.
  // Captured per workspace so a run keeps the behaviour it was launched with.
  llmJudge?: boolean
  teamId?: string
  status: ParallelWorkspaceStatus
  progress: number
  lastAction: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  riskLevel: "low" | "medium" | "high"
  estimatedCost: string
  actualCost?: string
  finalSummary: string
  mergeState: "none" | "merged" | "discarded"
  logs: string[]
  terminalOutput: string[]
  browserResults: string[]
  changedFiles: string[]
  diff: string
  checkpointPath?: string
  pullRequestUrl?: string
  baselineHashes?: Record<string, string>
  contextFiles?: string[]
  contextIndexedFiles?: number
  contextTokenEstimate?: number
  contextSummary?: string
  // Optional so every already-persisted record stays valid with no migration;
  // the UI falls back to the raw log view when it is empty.
  turns?: ParallelWorkspaceTurn[]
  taskDifficulty?: TaskDifficulty
  retryLimit?: number
  validationReport?: WorkspaceValidationReport
  validationPassed?: boolean
  repairAttempts?: number
  error?: string
}

export type ParallelWorkspaceEngine = {
  url: string
  username: string | null
  password: string | null
}

type ActiveParallelRun = {
  controller: AbortController
  engine: ParallelWorkspaceEngine
  sessionId?: string
  // Set only by followUpParallelWorkspace. Carried on the queue entry so a
  // follow-up rides executeParallelWorkspace's existing ledger pre-flight,
  // catch and finally instead of duplicating them.
  followUp?: string
}

const activeRuns = new Map<string, ActiveParallelRun>()
const queuedRuns = new Map<string, ActiveParallelRun>()
let maxConcurrentRuns = 16

function normalizeConcurrency(value?: number) {
  if (!Number.isFinite(value)) return maxConcurrentRuns
  return Math.max(1, Math.min(16, Math.floor(value!)))
}

function drainParallelRunQueue() {
  while (activeRuns.size < maxConcurrentRuns && queuedRuns.size > 0) {
    const next = queuedRuns.entries().next().value as [string, ActiveParallelRun] | undefined
    if (!next) return
    const [id, run] = next
    queuedRuns.delete(id)
    const record = readRecords().find((item) => item.id === id)
    if (!record || record.mergeState !== "none") continue
    activeRuns.set(id, run)
    const started = updateRecord(id, (current) => ({
      ...current,
      status: "planning",
      progress: 0,
      lastAction: `Starting isolated ${runtimeLabel(current.runtime)} session`,
      lastActivityAt: now(),
      error: undefined,
      logs: [`Agent slot opened at ${now()}.`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(started, `Parallel agent started with ${runtimeLabel(started.runtime)}.`)
    void executeParallelWorkspace(id, run.engine, run.controller)
  }
}

export type CreateParallelWorkspaceInput = {
  sourcePath: string
  parentSessionId?: string
  engineParentSessionId?: string
  name?: string
  taskPrompt: string
  runtime?: ParallelWorkspaceRuntime
  provider?: string
  model?: string
  agent?: string
  swarmRunId?: string
  swarmTaskId?: string
  swarmRole?: "coordinator" | "worker"
  teamId?: string
  sharedPath?: string
  llmJudge?: boolean
}

type CommandResult = {
  stdout: string
  stderr: string
  failed: boolean
}

const now = () => new Date().toISOString()
const workspaceRoot = () => join(app.getPath("userData"), WORKSPACE_DIRECTORY_NAME)
const runtimeLabel = (runtime: ParallelWorkspaceRuntime) =>
  runtime === "claude-code" ? "Claude Code" : runtime === "codex" ? "Codex" : runtime === "cursor" ? "Cursor Agent" : "Vector"

function readRecords(): ParallelWorkspaceRecord[] {
  const raw = getStore(STORE_NAME).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is ParallelWorkspaceRecord => typeof item?.id === "string")
    .map((item) => ({
      ...item,
      runtime:
        item.runtime === "claude-code" || item.runtime === "codex" || item.runtime === "cursor"
          ? item.runtime
          : "vector",
    }))
}

function writeRecords(records: ParallelWorkspaceRecord[]) {
  getStore(STORE_NAME).set(STORE_KEY, records)
}

function updateRecord(id: string, update: (record: ParallelWorkspaceRecord) => ParallelWorkspaceRecord) {
  const records = readRecords()
  const index = records.findIndex((record) => record.id === id)
  if (index === -1) throw new Error("Parallel workspace was not found.")
  records[index] = update(records[index]!)
  writeRecords(records)
  return records[index]!
}

function backgroundStatus(status: ParallelWorkspaceStatus): BackgroundTaskStatus {
  if (status === "queued") return "queued"
  if (status === "planning" || status === "editing" || status === "running commands" || status === "testing") {
    return "running"
  }
  if (status === "needs review") return "needs_review"
  if (status === "complete") return "complete"
  if (status === "failed") return "failed"
  if (status === "stopped") return "canceled"
  if (status === "merged") return "merged"
  if (status === "discarded") return "discarded"
  return "waiting"
}

function syncBackgroundTask(record: ParallelWorkspaceRecord, log?: string) {
  if (!record.backgroundTaskId) return
  try {
    updateBackgroundTask(record.backgroundTaskId, {
      workspaceName: record.name,
      prompt: record.taskPrompt,
      provider: record.provider,
      model: record.model,
      projectPath: record.sourcePath,
      taskId: record.parentSessionId,
      workspaceId: record.id,
      status: backgroundStatus(record.status),
      progress: record.progress,
      currentStep: record.lastAction,
      changedFilesCount: record.changedFilesCount,
      terminalActive: record.status === "running commands",
      browserActive: record.status === "testing",
      costEstimate: record.estimatedCost,
      actualUsage: record.actualCost,
      errorSummary: record.error,
      mergeState: record.mergeState,
      log,
      action: {
        label: record.lastAction,
        status:
          record.status === "failed"
            ? "failed"
            : record.status === "needs review"
              ? "warning"
              : record.status === "merged" || record.status === "complete"
                ? "success"
                : backgroundStatus(record.status) === "running"
                  ? "running"
                  : "pending",
        detail: record.error || record.finalSummary,
      },
    })
  } catch {
    // Background tasks are an observability layer; workspace operations must not fail because
    // task metadata was cleared or migrated.
  }
}

function safeName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return normalized.slice(0, 42) || "workspace"
}

function withTimeout<T>(promise: Promise<T>, message: string, milliseconds = 25_000) {
  let timeout: NodeJS.Timeout | undefined
  const timer = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([promise, timer]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function engineHeaders(engine: ParallelWorkspaceEngine) {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  }
  if (engine.username && engine.password) {
    headers.authorization = `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`
  }
  return headers
}

async function engineRequest<T>(
  engine: ParallelWorkspaceEngine,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
) {
  const base = engine.url.endsWith("/") ? engine.url : `${engine.url}/`
  const response = await fetch(new URL(path.replace(/^\//, ""), base), {
    method: init.method ?? "GET",
    headers: engineHeaders(engine),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Vector engine request failed (${response.status})${body ? `: ${body.slice(0, 500)}` : ""}`)
  }
  if (response.status === 204) return undefined as T
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function collectText(value: unknown, output: string[] = []) {
  if (!value) return output
  if (typeof value === "string") return output
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output)
    return output
  }
  if (typeof value !== "object") return output
  const record = value as Record<string, unknown>
  if (record.type === "text" && typeof record.text === "string" && record.text.trim()) output.push(record.text.trim())
  for (const item of Object.values(record)) collectText(item, output)
  return output
}

type EngineActiveSession = Record<string, unknown>

function sleep(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Parallel workspace run was canceled.", "AbortError"))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new DOMException("Parallel workspace run was canceled.", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function activeSessionMap(value: unknown): Record<string, EngineActiveSession> {
  if (!value || typeof value !== "object") return {}
  const record = value as Record<string, unknown>
  const candidate = record.data && typeof record.data === "object" ? record.data : record
  return candidate as Record<string, EngineActiveSession>
}

async function refreshRunningWorkspace(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) throw new Error("Parallel workspace was not found.")
  const { changedFiles, diff } =
    record.isolation === "git-worktree" ? await gitDiff(record) : await fallbackDiff(record)
  return updateRecord(id, (current) => ({
    ...current,
    changedFiles,
    diff,
    changedFilesCount: changedFiles.length,
    riskLevel: riskFromDiff(diff, changedFiles),
    lastActivityAt: now(),
  }))
}

// The engine going idle says the turn ended, not that it succeeded. A provider
// 429, an auth failure or a context overflow all end the turn with
// finish: "error", and without this the workspace was recorded as "complete
// with no file changes" — a green result for a run that never did anything,
// on exactly the unattended path the feature exists to protect.
// Both message shapes are accepted: v2 is flat, the legacy route wraps in `info`.
type EngineTurnMessage = {
  type?: string
  finish?: string
  error?: { message?: string; data?: { message?: string } } | string
  info?: { role?: string; finish?: string; error?: { message?: string; data?: { message?: string } } | string }
}

async function engineTurnFailure(
  sessionId: string,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
): Promise<string | undefined> {
  const raw = await engineRequest<{ data?: EngineTurnMessage[] } | undefined>(
    engine,
    `/api/session/${encodeURIComponent(sessionId)}/message?limit=20`,
    { signal },
  ).catch(() => undefined)
  const assistants = (raw?.data ?? [])
    .map((item) => (item.info?.role === "assistant" ? item.info : item.type === "assistant" ? item : undefined))
    .filter(Boolean)
  const last = assistants.at(-1)
  if (!last) return undefined
  if (last.finish !== "error" && !last.error) return undefined
  if (typeof last.error === "string") return last.error
  return last.error?.data?.message ?? last.error?.message ?? "The agent's turn ended with an error."
}

async function waitForEngineSessionIdle(
  id: string,
  sessionId: string,
  engine: ParallelWorkspaceEngine,
  signal: AbortSignal,
) {
  const startedAt = Date.now()
  const timeoutAt = startedAt + 30 * 60_000
  let observedBusy = false
  let idleSamples = 0
  let lastState = "starting"
  let lastDiffRefresh = 0

  while (Date.now() < timeoutAt) {
    if (signal.aborted) throw new DOMException("Parallel workspace run was canceled.", "AbortError")
    // Parallel Workspaces use the v2 session engine. The legacy
    // /session/status route only tracks v1 sessions and can report idle while
    // the v2 agent is still editing. /api/session/active is the authoritative
    // registry for the engine loop admitted by /api/session/:id/prompt.
    const raw = await engineRequest<unknown>(engine, "/api/session/active", { signal })
    const state = activeSessionMap(raw)[sessionId] ? "busy" : "idle"

    if (state !== "idle") {
      observedBusy = true
      idleSamples = 0
    } else {
      idleSamples += 1
      // Busy sessions disappear from /api/session/active when they become
      // idle. If the session was never observed busy, give the engine a real
      // grace window: under heavy concurrency the prompt can be durably
      // admitted seconds before the agent loop starts, and declaring "idle"
      // too early marks an untouched workspace complete while the agent later
      // edits it with nobody watching.
      if ((observedBusy && idleSamples >= 1) || (Date.now() - startedAt >= 20_000 && idleSamples >= 6)) return
    }

    if (state !== lastState) {
      lastState = state
      const label =
        state === "busy"
          ? "Agent is editing and running tools"
          : "Waiting for the isolated agent to start"
      const updated = updateRecord(id, (current) => ({
        ...current,
        status: "running commands",
        lastAction: label,
        lastActivityAt: now(),
        logs: [`Engine status changed to ${state}.`, ...current.logs].slice(0, 120),
      }))
      syncBackgroundTask(updated, label)
    }

    if (Date.now() - lastDiffRefresh >= 2_000) {
      lastDiffRefresh = Date.now()
      const updated = await refreshRunningWorkspace(id)
      syncBackgroundTask(updated)
    }
    await sleep(650, signal)
  }

  throw new Error("The isolated agent did not become idle within 30 minutes. Its files are preserved for review.")
}

function parallelAgentPrompt(record: ParallelWorkspaceRecord) {
  const contextPack = record.contextFiles?.length
    ? [
        record.contextSummary || `Vector indexed ${record.contextIndexedFiles ?? 0} source files locally.`,
        `Inspect these task-relevant files first (about ${(record.contextTokenEstimate ?? 0).toLocaleString()} tokens if all are read):`,
        ...record.contextFiles.map((file) => `- ${file}`),
        "Expand beyond this context pack only when imports, references, or validation failures prove another file is relevant.",
      ].join("\n")
    : "Use repository search to identify the smallest relevant context before reading large files."
  return [
    record.swarmRunId
      ? `You are Vector's ${record.agent || "general"} worker inside an automatically orchestrated engineering swarm.`
      : "You are Vector's Parallel Workspace engineering agent.",
    `You are operating only inside this isolated workspace: ${record.isolatedPath}`,
    `The main project at ${record.sourcePath} must remain untouched.`,
    record.swarmTaskId ? `Swarm task ID: ${record.swarmTaskId}` : "",
    "Inspect the repository before editing. Make the smallest complete implementation that satisfies the task.",
    record.taskDifficulty === "complex"
      ? "Create a visible plan, parallelize independent exploration when useful, and validate each major phase before continuing."
      : "Keep a concise plan for the work and update it when evidence changes the approach.",
    "Use terminal tools when useful, run the most relevant available checks, and repair failures you introduce.",
    "Do not expose credentials or copy secrets into source files.",
    "Finish with a concise summary of changed files, validation performed, and any remaining risk.",
    "Read .vector/BRAIN.md when present and update it only with durable decisions or recurring failure lessons; never store secrets or routine narration.",
    // Rules are keyed on the MAIN project path, not the isolated checkout: a
    // worktree lives under Vector's own directory and would match nothing. The
    // engine also loads .vector/RULES.md for Vector-runtime agents, but an
    // external CLI reads its own instruction files and never sees that one, so
    // the prompt is the only place the rules reliably reach every runtime.
    formatRulesForPrompt(repoRulesForPrompt(record.sourcePath, record.changedFiles)),
    // Same policy the composer injects, so turning the setting on covers
    // isolated agents too rather than only the session you are typing in.
    record.llmJudge ? "" : undefined,
    record.llmJudge ? VERIFIED_COMPLETION_POLICY : undefined,
    "",
    contextPack,
    "",
    `Mission: ${record.name}`,
    `Task: ${record.taskPrompt}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

function validationLogLines(report: WorkspaceValidationReport) {
  if (!report.checks.length) return ["No deterministic project checks were detected for this workspace."]
  return report.checks.flatMap((check) => {
    const command = [check.command, ...check.args].join(" ")
    const status = check.status === "passed" ? "PASS" : check.status === "failed" ? "FAIL" : "SKIP"
    return [`[${status}] $ ${command} (${check.durationMs}ms)`, check.output]
  })
}

function validationSummary(report: WorkspaceValidationReport) {
  if (!report.checks.length || !report.hadChecks) return "No runnable deterministic checks were available."
  const passed = report.checks.filter((check) => check.status === "passed").length
  const skipped = report.checks.filter((check) => check.status === "skipped").length
  if (report.passed) return `${passed} deterministic check${passed === 1 ? "" : "s"} passed${skipped ? `; ${skipped} skipped` : ""}.`
  const failed = report.checks.find((check) => check.status === "failed")
  return `${failed?.label || "A deterministic check"} failed after the isolated edit.`
}

// `report.passed` is computed as `failures.length === 0`, so it is vacuously
// true when no checks ran at all. Branching user-facing copy on it alone tells
// the user their work was verified when nothing was executed. Every status
// string routes through here so "nothing ran" can never render as "passed".
function checksOutcome(report: WorkspaceValidationReport) {
  if (!report.hadChecks || !report.checks.length) return "none" as const
  return report.passed ? ("passed" as const) : ("failed" as const)
}

function checksAction(report: WorkspaceValidationReport) {
  const outcome = checksOutcome(report)
  if (outcome === "none") return "No deterministic checks were available to run"
  return outcome === "passed" ? "Deterministic checks passed" : "Deterministic checks found a failure"
}

function reviewAction(report: WorkspaceValidationReport) {
  const outcome = checksOutcome(report)
  if (outcome === "none") return "Ready for review — no deterministic checks were available"
  return outcome === "passed"
    ? "Workspace is validated and ready for review"
    : "Workspace needs review: deterministic checks failed"
}

// Failure signatures are knowledge about the repository, not about this run, so
// they accumulate against the source project even though the checks ran in a
// throwaway worktree that is deleted on merge. Both paths are passed as roots
// so the same failure seen from either tree collapses to one signature.
// `repairDescription` is what the agent said it changed in the pass this run is
// verifying: a passing check turns it into the known repair for that signature.
function rememberValidation(
  record: ParallelWorkspaceRecord,
  report: WorkspaceValidationReport,
  repairDescription = "",
) {
  return recordValidationRun(record.sourcePath, {
    report,
    changedFiles: record.changedFiles,
    diff: record.diff,
    roots: [record.isolatedPath, record.sourcePath],
    repairDescription,
  })
}

// core.quotePath defaults on, so git C-quotes any non-ASCII path — a file named
// café.txt comes back as "caf\303\251.txt". Every caller here parses these
// lists as literal paths, so a merge would list a name that does not exist,
// skip it in the review diff and the secret scan, and then throw ENOENT partway
// through — after `git apply` had already written to main. Disabling it once at
// the single chokepoint covers status, ls-files and diff --name-only together.
const GIT_PATH_CONFIG = ["-c", "core.quotePath=false"]

export function runGit(args: string[], cwd: string, options: { allowFailure?: boolean; input?: string } = {}) {
  const allowFailure = options.allowFailure ?? false
  return withTimeout(
    new Promise<CommandResult>((resolve, reject) => {
      const child = execFile(
        "git",
        [...GIT_PATH_CONFIG, ...args],
        { cwd, env: untrustedChildEnvironment(), maxBuffer: 96 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const result = { stdout: String(stdout), stderr: String(stderr), failed: Boolean(error) }
          if (error && !allowFailure) return reject(error)
          resolve(result)
        },
      )
      if (options.input !== undefined) {
        child.stdin?.write(options.input)
        child.stdin?.end()
      }
    }),
    `Git command timed out: git ${args.join(" ")}`,
  )
}

async function gitRoot(sourcePath: string) {
  const result = await runGit(["rev-parse", "--show-toplevel"], sourcePath, { allowFailure: true })
  const root = result.stdout.trim()
  return root || undefined
}

async function gitIsClean(sourcePath: string) {
  const result = await runGit(["status", "--porcelain"], sourcePath, { allowFailure: true })
  return !result.failed && result.stdout.trim().length === 0
}

// Only inject a throwaway identity when the repo has none, so a commit never
// overrides the user's own git config. Mirrors github.ts buildCommitArgs; kept
// local so parallel merges do not depend on the GitHub module's internals.
async function buildCommitArgs(projectPath: string, message: string): Promise<string[]> {
  const email = await runGit(["config", "user.email"], projectPath, { allowFailure: true })
  const hasEmail = !email.failed && email.stdout.trim().length > 0
  const identity = hasEmail ? [] : ["-c", "user.name=Vector", "-c", "user.email=noreply@vectordev.ai"]
  return [...identity, "commit", "-m", message]
}

function extension(file: string) {
  const dot = file.lastIndexOf(".")
  return dot === -1 ? "" : file.slice(dot).toLowerCase()
}

function shouldSkip(name: string) {
  return EXCLUDED_DIRS.has(name)
}

async function listProjectFiles(root: string, current = root, output: string[] = []) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue
    if (entry.isDirectory()) {
      if (shouldSkip(entry.name)) continue
      await listProjectFiles(root, join(current, entry.name), output)
      continue
    }
    if (!entry.isFile()) continue
    const fullPath = join(current, entry.name)
    const info = await stat(fullPath).catch(() => undefined)
    if (!info || info.size > 5 * 1024 * 1024) continue
    output.push(relative(root, fullPath))
  }
  return output.sort()
}

async function hashFile(path: string) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Cannot hash a non-file path: ${path}`)
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolve)
  })
  return hash.digest("hex")
}

async function hashProject(root: string) {
  const files = await listProjectFiles(root)
  const hashes: Record<string, string> = {}
  for (const file of files) {
    hashes[file] = await hashFile(join(root, file)).catch(() => "missing")
  }
  return hashes
}

async function copyProject(sourcePath: string, targetPath: string) {
  await mkdir(dirname(targetPath), { recursive: true })
  await cp(sourcePath, targetPath, {
    recursive: true,
    dereference: false,
    filter: (source) => !source.split(/[\\/]/).some((part) => shouldSkip(part)),
  })
}

function estimateCost(taskPrompt: string, hashes: Record<string, string>, contextTokens?: number) {
  const fileCount = Object.keys(hashes).length
  const roughTokens = Math.ceil(taskPrompt.length / 4 + (contextTokens ?? Math.min(fileCount * 120, 120_000)))
  if (roughTokens < 6_000) return "< $0.01"
  if (roughTokens < 30_000) return "$0.01-$0.05"
  if (roughTokens < 120_000) return "$0.05-$0.20"
  return "$0.20+"
}

function riskFromDiff(diff: string, changedFiles: string[]) {
  const additions = (diff.match(/^\+/gm) ?? []).length
  const deletions = (diff.match(/^-/gm) ?? []).length
  if (changedFiles.length >= 12 || deletions > 400 || additions > 800) return "high"
  if (changedFiles.length >= 4 || deletions > 80 || additions > 180) return "medium"
  return "low"
}

async function textPreview(path: string) {
  const text = await readFile(path, "utf8").catch(() => "")
  return text.slice(0, 40_000)
}

function normalizeStatusLine(line: string) {
  const file = line.slice(3).trim()
  if (file.includes(" -> ")) return file.split(" -> ").pop()?.trim() ?? file
  return file
}


// Teammates communicate by relay: a queued message is folded into the
// recipient's next prompt rather than interrupting it mid-turn. Claiming marks
// delivery, so a message is handed over exactly once.
function withTeammateMessages(record: ParallelWorkspaceRecord, basePrompt: string) {
  const team = teamForWorkspace(record.id)
  if (!team) return basePrompt
  const pending = claimPendingMessages(team.id, record.id)
  if (!pending.length) return basePrompt
  return [formatDelivery(pending, record.name), basePrompt].join("\n\n")
}

// Members of a shared workspace all write to one outbox, so each entry carries
// the sending session. Draining is destructive: an entry is routed exactly once
// and the file is truncated, otherwise every later turn would replay the whole
// history to the team.
export async function drainTeamOutbox(record: ParallelWorkspaceRecord) {
  const team = teamForWorkspace(record.id)
  if (!team) return
  const outbox = join(record.isolatedPath, ".vector", "team-outbox.jsonl")
  const raw = await readFile(outbox, "utf8").catch(() => "")
  if (!raw.trim()) return
  await writeFile(outbox, "", "utf8").catch(() => undefined)

  const siblings = readRecords().filter((item) => team.memberIds.includes(item.id))
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    const entry = ((): { to?: string; message?: string; sessionID?: string } | undefined => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })()
    if (!entry?.message) continue
    // Attribute by session so a shared outbox routes to the right sender.
    const sender = siblings.find((item) => item.agentSessionId === entry.sessionID) ?? record
    const recipient = entry.to
      ? siblings.find((item) => item.name.toLowerCase() === entry.to!.trim().toLowerCase())
      : undefined
    postTeamMessage({
      teamId: team.id,
      fromWorkspaceId: sender.id,
      fromName: sender.name,
      toWorkspaceId: recipient?.id,
      text: entry.message,
    })
  }
}

// Delivery only ever happens at a turn boundary, because the engine cannot
// inject into a turn already in progress. Everything in a team therefore has to
// be drained WHILE the members are running: they all start together, so at the
// moment the first prompts go out nobody has written anything yet, and draining
// only at the end meant a queued message was never read by anyone.
const TEAM_SWEEP_INTERVAL_MS = 4_000
const teamSweeps = new Map<string, { timer: NodeJS.Timeout; runs: Set<string> }>()

function startTeamSweep(record: ParallelWorkspaceRecord) {
  const team = teamForWorkspace(record.id)
  if (!team) return
  const existing = teamSweeps.get(team.id)
  if (existing) {
    existing.runs.add(record.id)
    return
  }
  const timer = setInterval(() => {
    void sweepTeamOutboxes(team.id)
  }, TEAM_SWEEP_INTERVAL_MS)
  // A sweep must never hold the process open on its own.
  timer.unref?.()
  teamSweeps.set(team.id, { timer, runs: new Set([record.id]) })
}

function stopTeamSweep(record: ParallelWorkspaceRecord) {
  const team = teamForWorkspace(record.id)
  if (!team) return
  const sweep = teamSweeps.get(team.id)
  if (!sweep) return
  sweep.runs.delete(record.id)
  if (sweep.runs.size > 0) return
  clearInterval(sweep.timer)
  teamSweeps.delete(team.id)
}

// Routes whatever every member has written so far. Reading each member's outbox
// rather than only the one that just finished is what lets a message cross
// between two agents that are both still working.
export async function sweepTeamOutboxes(teamId: string) {
  const members = readRecords().filter((record) => teamForWorkspace(record.id)?.id === teamId)
  for (const member of members) await drainTeamOutbox(member)
}

// Broadcasts what this agent just did so teammates sharing the workspace can
// adapt instead of rediscovering it from the diff.
function broadcastHandoff(record: ParallelWorkspaceRecord, summary: string) {
  const team = teamForWorkspace(record.id)
  if (!team || team.memberIds.length < 2) return
  postTeamMessage({
    teamId: team.id,
    fromWorkspaceId: record.id,
    fromName: record.name,
    text: formatHandoff(record.name, summary, record.changedFiles),
  })
}

async function fallbackDiff(record: ParallelWorkspaceRecord) {
  const sourceFiles = await listProjectFiles(record.sourcePath)
  const isolatedFiles = await listProjectFiles(record.isolatedPath)
  const allFiles = Array.from(new Set([...sourceFiles, ...isolatedFiles])).sort()
  const changedFiles: string[] = []
  const blocks: string[] = []

  for (const file of allFiles) {
    const before = record.baselineHashes?.[file] ?? "missing"
    const isolatedPath = join(record.isolatedPath, file)
    const isolatedHash = await hashFile(isolatedPath).catch(() => "missing")
    if (before === isolatedHash) continue
    changedFiles.push(file)
    const ext = extension(file)
    blocks.push(`diff --vector a/${file} b/${file}`)
    if (!TEXT_EXTENSIONS.has(ext)) {
      blocks.push("Binary or large file changed.")
      continue
    }
    const sourceText = await textPreview(join(record.sourcePath, file))
    const isolatedText = await textPreview(isolatedPath)
    blocks.push(`--- a/${file}`)
    blocks.push(`+++ b/${file}`)
    blocks.push("@@")
    blocks.push(sourceText ? sourceText.split("\n").slice(0, 80).map((line) => `- ${line}`).join("\n") : "- <missing>")
    blocks.push(isolatedText ? isolatedText.split("\n").slice(0, 120).map((line) => `+ ${line}`).join("\n") : "+ <deleted>")
  }

  return { changedFiles, diff: blocks.join("\n") }
}

// Vector's own coordination files live inside the workspace because the engine
// resolves them relative to the agent's working directory. They are bookkeeping,
// not the agent's work, so they never belong in a diff or a merge.
// .vector/BRAIN.md is deliberately NOT here: durable project memory is
// something the user may legitimately want to keep.
const INTERNAL_WORKSPACE_FILES = new Set([
  join(".vector", "team.json").replaceAll("\\", "/"),
  join(".vector", "team-outbox.jsonl").replaceAll("\\", "/"),
])

const isInternalWorkspaceFile = (file: string) => INTERNAL_WORKSPACE_FILES.has(file.replaceAll("\\", "/"))

async function gitDiff(record: ParallelWorkspaceRecord) {
  // -uall lists untracked files individually. Without it git collapses a new
  // directory to a single "dir/" entry, which both hid every file in a newly
  // created directory from the review diff (textPreview cannot read a
  // directory) and made per-file exclusions impossible to apply.
  const status = await runGit(["status", "--porcelain", "-uall"], record.isolatedPath, { allowFailure: true })
  const untrackedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("??"))
    .map(normalizeStatusLine)
    .filter(Boolean)
    .filter((file) => !isInternalWorkspaceFile(file))
  const baseCommit = record.baseCommit ?? "HEAD"
  const trackedFiles = await runGit(["diff", "--name-only", baseCommit, "--"], record.isolatedPath, {
    allowFailure: true,
  })
  const changedFiles = [
    ...new Set([
      ...trackedFiles.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((file) => !isInternalWorkspaceFile(file)),
      ...untrackedFiles,
    ]),
  ]
  const diff = await runGit(["diff", "--no-ext-diff", "--binary", baseCommit, "--"], record.isolatedPath, {
    allowFailure: true,
  })
  const blocks = [diff.stdout.trim()]
  for (const file of untrackedFiles) {
    const fullPath = join(record.isolatedPath, file)
    if (!TEXT_EXTENSIONS.has(extension(file))) continue
    const text = await textPreview(fullPath)
    if (!text) continue
    blocks.push(`diff --git a/${file} b/${file}`)
    blocks.push("new file mode 100644")
    blocks.push("--- /dev/null")
    blocks.push(`+++ b/${file}`)
    blocks.push("@@")
    blocks.push(text.split("\n").slice(0, 300).map((line) => `+${line}`).join("\n"))
  }
  return { changedFiles, diff: blocks.filter(Boolean).join("\n") }
}

// Build a unified diff of the MAIN project's working tree against HEAD, in the
// same header format ParallelDiffReview/parseUnifiedDiff already parse. Mirrors
// gitDiff() but runs against sourcePath with base HEAD so the review UI can show
// "Main" and "Side-by-side" columns. Returns "" when sourcePath is not a git
// repository (read-only; never mutates the tree).
export async function mainWorkingTreeDiff(sourcePath: string): Promise<string> {
  if (!(await gitRoot(sourcePath))) return ""
  // -uall for the same reason as gitDiff: a collapsed "dir/" entry cannot be
  // read by textPreview, so new directories would silently show no changes.
  const status = await runGit(["status", "--porcelain", "-uall"], sourcePath, { allowFailure: true })
  const untrackedFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("??"))
    .map(normalizeStatusLine)
    .filter(Boolean)
  const diff = await runGit(["diff", "--no-ext-diff", "--binary", "HEAD", "--"], sourcePath, {
    allowFailure: true,
  })
  const blocks = [diff.stdout.trim()]
  for (const file of untrackedFiles) {
    const fullPath = join(sourcePath, file)
    if (!TEXT_EXTENSIONS.has(extension(file))) continue
    const text = await textPreview(fullPath)
    if (!text) continue
    blocks.push(`diff --git a/${file} b/${file}`)
    blocks.push("new file mode 100644")
    blocks.push("--- /dev/null")
    blocks.push(`+++ b/${file}`)
    blocks.push("@@")
    blocks.push(text.split("\n").slice(0, 300).map((line) => `+${line}`).join("\n"))
  }
  return blocks.filter(Boolean).join("\n")
}

export async function refreshParallelWorkspace(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) throw new Error("Parallel workspace was not found.")
  // Merged/discarded workspaces had their isolated checkout cleaned up; a
  // refresh would re-diff a missing directory and wipe the recorded history.
  if (record.mergeState !== "none") return record
  if (!(await stat(record.isolatedPath).catch(() => undefined))) return record
  const { changedFiles, diff } =
    record.isolation === "git-worktree" ? await gitDiff(record) : await fallbackDiff(record)
  const updated = updateRecord(id, (current) => ({
    ...current,
    changedFiles,
    diff,
    changedFilesCount: changedFiles.length,
    riskLevel: riskFromDiff(diff, changedFiles),
    lastActivityAt: now(),
    lastAction: changedFiles.length
      ? `${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"} detected`
      : "No isolated changes yet",
    // A refresh during a live turn must not flip the record to "needs review"
    // under the running agent: the mission path already refreshed mid-run, and
    // a follow-up refreshes mid-turn too, which made the churn visible.
    status:
      current.mergeState !== "none" || activeRuns.has(id) || queuedRuns.has(id)
        ? current.status
        : changedFiles.length
          ? "needs review"
          : current.status,
  }))
  syncBackgroundTask(updated)
  return updated
}

export function listParallelWorkspaces(scope?: { sourcePath?: string; parentSessionId?: string }) {
  const records = readRecords()
  let changed = false
  const next = records.map((record) => {
    const wasRunning = ["planning", "editing", "running commands", "testing"].includes(record.status)
    if (!wasRunning || activeRuns.has(record.id) || queuedRuns.has(record.id)) return record
    changed = true
    const interrupted: ParallelWorkspaceRecord = {
      ...record,
      status: "failed",
      progress: 0,
      lastAction: "Interrupted by app restart",
      lastActivityAt: now(),
      error: "This agent stopped when Vector closed. Review the isolated files, then run the workspace again if needed.",
      finalSummary: "The previous run was interrupted before Vector received a completion signal.",
      turns: settleRunningTurns(record.turns, { state: "failed", text: "This turn stopped when Vector closed." }),
      logs: ["Vector detected an interrupted agent run after restart.", ...record.logs].slice(0, 120),
    }
    syncBackgroundTask(interrupted, "Interrupted run detected after Vector restarted.")
    return interrupted
  })
  if (changed) writeRecords(next)
  if (!scope) return next
  return next.filter((record) => {
    if (scope.sourcePath && record.sourcePath !== scope.sourcePath) return false
    if ("parentSessionId" in scope && record.parentSessionId !== scope.parentSessionId) return false
    return true
  })
}

export function getParallelWorkspace(id: string) {
  return readRecords().find((record) => record.id === id)
}

export async function createParallelWorkspace(input: CreateParallelWorkspaceInput) {
  if (!input.parentSessionId) {
    throw new Error("Open a task session before creating an isolated agent workspace.")
  }
  const sourceStat = await stat(input.sourcePath).catch(() => undefined)
  if (!sourceStat?.isDirectory()) throw new Error("Choose a valid project folder before creating a parallel workspace.")

  const createdAt = now()
  const id = randomUUID()
  const sourceRoot = (await gitRoot(input.sourcePath)) ?? input.sourcePath
  const activeInScope = readRecords().filter(
    (record) =>
      record.sourcePath === sourceRoot &&
      record.parentSessionId === input.parentSessionId &&
      record.swarmRole !== "coordinator" &&
      record.mergeState === "none" &&
      !["failed", "stopped", "complete"].includes(record.status),
  )
  if (activeInScope.length >= 16) {
    throw new Error("This task already has 16 active parallel agents. Merge, discard, or remove one before creating another.")
  }
  const root = workspaceRoot()
  const workspaceDir = join(root, id)
  let isolatedPath = join(workspaceDir, "workspace")
  const taskDifficulty = classifyTaskDifficulty(input.taskPrompt)
  const runtime = input.runtime ?? "vector"
  const estimatedCost =
    runtime === "vector"
      ? taskDifficulty === "trivial"
        ? estimateCost(input.taskPrompt, {})
        : "Calculating from task context"
      : "Reported by runtime when available"
  const name = input.name?.trim() || `Agent ${activeInScope.length + 1}`
  const runtimeName = runtimeLabel(runtime)
  const provider = runtime === "vector" ? input.provider?.trim() || "Current Vector provider" : runtimeName
  const model = runtime === "vector" ? input.model?.trim() || "Current selected model" : "Runtime default"

  let isolation: ParallelWorkspaceRecord["isolation"] = "copy"
  let gitBranch: string | undefined
  let baseCommit: string | undefined
  const logs: string[] = []

  // A collaborative member joins an existing tree rather than getting its own,
  // which is the point of the topology: teammates see each other's edits as
  // they happen instead of at merge time. Skip worktree creation entirely and
  // adopt the shared checkout.
  const joinShared = Boolean(input.sharedPath)
  if (input.sharedPath) {
    isolatedPath = input.sharedPath
    isolation = input.sharedPath === sourceRoot ? "copy" : "git-worktree"
    baseCommit =
      (await runGit(["rev-parse", "HEAD"], input.sharedPath, { allowFailure: true })).stdout.trim() || undefined
    logs.push(`Joined the shared workspace at ${input.sharedPath}.`)
  }

  await mkdir(workspaceDir, { recursive: true })
  const rootGit = await gitRoot(sourceRoot)
  if (joinShared) {
    // Nothing to provision: the tree already exists and teammates are in it.
  } else if (rootGit && (await gitIsClean(sourceRoot))) {
    baseCommit = (await runGit(["rev-parse", "HEAD"], sourceRoot, { allowFailure: true })).stdout.trim() || undefined
    gitBranch = `vector-parallel/${safeName(name)}-${id.slice(0, 8)}`
    try {
      await runGit(["worktree", "add", "-b", gitBranch, isolatedPath, "HEAD"], sourceRoot)
      isolation = "git-worktree"
      logs.push(`Created git worktree on ${gitBranch}.`)
    } catch (error) {
      logs.push(`Git worktree failed, using isolated copy: ${error instanceof Error ? error.message : String(error)}`)
      await copyProject(sourceRoot, isolatedPath)
    }
  } else {
    logs.push(
      rootGit
        ? "Main project has uncommitted changes, using isolated copy to preserve current state."
        : "No git repository found, using isolated copy.",
    )
    await copyProject(sourceRoot, isolatedPath)
  }

  // Written only after provisioning: `git worktree add` refuses a target
  // directory that already has anything in it, so creating this marker first
  // made worktree creation fail for the first member of every team and
  // silently drop it into an unisolated copy.
  //
  // The engine-side tool checks for this marker before offering to message a
  // teammate, so an agent working alone is never told a message was queued.
  if (input.teamId) {
    await mkdir(join(isolatedPath, ".vector"), { recursive: true }).catch(() => undefined)
    await writeFile(
      join(isolatedPath, ".vector", "team.json"),
      JSON.stringify({ teamId: input.teamId, workspaceId: id, name }, null, 2),
      "utf8",
    ).catch(() => undefined)
  }

  await mkdir(join(workspaceDir, "metadata"), { recursive: true })
  await writeFile(
    join(workspaceDir, "metadata", "task.md"),
    [
      `# ${name}`,
      "",
      `Created: ${createdAt}`,
      `Runtime: ${runtimeName}`,
      `Provider: ${provider}`,
      `Model: ${model}`,
      "",
      "## Task",
      input.taskPrompt.trim() || "No task prompt provided.",
      "",
      "This workspace is isolated. Open it in Vector to run the agent. Merge when the result is ready.",
      "",
    ].join("\n"),
    "utf8",
  )

  const backgroundTask = input.swarmRole === "coordinator"
    ? undefined
    : createBackgroundTask({
        kind: "parallel-workspace",
        projectPath: sourceRoot,
        taskId: input.parentSessionId,
        workspaceId: id,
        workspaceName: name,
        name,
        prompt: input.taskPrompt.trim(),
        provider,
        model,
        status: "queued",
        progress: 0,
        currentStep: "Isolated workspace created",
        changedFilesCount: 0,
        terminalActive: false,
        browserActive: false,
        costEstimate: estimatedCost,
        mergeState: "none",
        logs: [`Created isolated workspace at ${isolatedPath}.`, ...logs],
      })

  const record: ParallelWorkspaceRecord = {
    id,
    name,
    taskPrompt: input.taskPrompt.trim(),
    runtime,
    provider,
    model,
    sourcePath: sourceRoot,
    parentSessionId: input.parentSessionId,
    engineParentSessionId: input.engineParentSessionId,
    isolatedPath,
    isolation,
    gitBranch,
    baseCommit,
    backgroundTaskId: backgroundTask?.id,
    agent: input.agent,
    swarmRunId: input.swarmRunId,
    swarmTaskId: input.swarmTaskId,
    swarmRole: input.swarmRole,
    teamId: input.teamId,
    llmJudge: input.llmJudge === true,
    status: "queued",
    progress: 0,
    lastAction: "Isolated workspace created",
    createdAt,
    lastActivityAt: createdAt,
    changedFilesCount: 0,
    riskLevel: "low",
    estimatedCost,
    finalSummary: "Workspace is ready. Open it to run an isolated agent session, then review the diff before merging.",
    mergeState: "none",
    logs,
    terminalOutput: [],
    browserResults: [],
    changedFiles: [],
    diff: "",
    baselineHashes: undefined,
    taskDifficulty,
    retryLimit: taskDifficulty === "complex" ? 2 : taskDifficulty === "trivial" ? 0 : 1,
    repairAttempts: 0,
  }
  writeRecords([record, ...readRecords()])
  return record
}

async function ensureParallelWorkspaceIsolation(record: ParallelWorkspaceRecord) {
  const isolated = await stat(record.isolatedPath).catch(() => undefined)
  if (isolated?.isDirectory()) return record
  const source = await stat(record.sourcePath).catch(() => undefined)
  if (!source?.isDirectory()) {
    throw new Error("The main project folder no longer exists. Open the project again before rerunning this workspace.")
  }

  await rm(dirname(record.isolatedPath), { recursive: true, force: true }).catch(() => undefined)
  await copyProject(record.sourcePath, record.isolatedPath)
  const baselineHashes = await hashProject(record.sourcePath)
  const restored = updateRecord(record.id, (current) => ({
    ...current,
    isolation: "copy",
    gitBranch: undefined,
    baseCommit: undefined,
    baselineHashes,
    changedFiles: [],
    changedFilesCount: 0,
    diff: "",
    progress: 0,
    error: undefined,
    lastAction: "Rebuilt interrupted isolated workspace",
    lastActivityAt: now(),
    // The rebuilt tree has none of the prior edits, and claude's resume is
    // scoped to the cwd it was created in — resuming here would hand the agent
    // a transcript describing files that no longer exist.
    externalSessionId: undefined,
    turns: appendTurn(current.turns, {
      id: randomUUID(),
      role: "vector",
      text: "The isolated workspace was missing, so Vector rebuilt it from the main project. The previous conversation could not be carried over.",
      at: now(),
      state: "done",
    }),
    logs: [
      "The isolated checkout was missing, so Vector rebuilt it from the current main project before starting the agent.",
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(restored, "Rebuilt the missing isolated workspace from the current main project.")
  return restored
}

async function prepareParallelWorkspaceContext(record: ParallelWorkspaceRecord) {
  const needsBaseline = record.isolation === "copy" && record.baselineHashes === undefined
  const needsContext = record.taskDifficulty !== "trivial" && record.contextIndexedFiles === undefined
  if (!needsBaseline && !needsContext) return record

  const [baselineHashes, contextPack] = await Promise.all([
    needsBaseline ? hashProject(record.isolatedPath) : Promise.resolve(record.baselineHashes),
    needsContext
      ? createContextBudgetPack(
          record.isolatedPath,
          record.taskPrompt,
          contextBudgetForDifficulty(record.taskDifficulty ?? "standard"),
        ).catch(() => undefined)
      : Promise.resolve(undefined),
  ])
  const contextTokens = contextPack?.estimatedTokens ?? record.contextTokenEstimate
  const updated = updateRecord(record.id, (current) => ({
    ...current,
    baselineHashes,
    estimatedCost:
      current.runtime === "vector"
        ? estimateCost(current.taskPrompt, baselineHashes ?? {}, contextTokens)
        : current.estimatedCost,
    contextFiles: contextPack?.files.map((file) => file.path) ?? current.contextFiles,
    contextIndexedFiles: contextPack?.indexedFileCount ?? current.contextIndexedFiles,
    contextTokenEstimate: contextTokens,
    contextSummary: contextPack
      ? formatContextBudgetForAgent(contextPack).split("\n")[0]
      : current.contextSummary,
    logs: contextPack
      ? [
          `Context budget selected ${contextPack.selectedFileCount} of ${contextPack.indexedFileCount} indexed files (~${contextPack.estimatedTokens.toLocaleString()} tokens).`,
          ...current.logs,
        ].slice(0, 120)
      : current.logs,
    lastActivityAt: now(),
  }))
  syncBackgroundTask(updated, "Task-specific context is ready in the isolated workspace.")
  return updated
}

async function runExternalWorkspacePass(input: {
  id: string
  record: ParallelWorkspaceRecord
  prompt: string
  controller: AbortController
  turnId: string
  resumeSessionId?: string
}) {
  const pendingLogs: string[] = []
  const pendingOutput: string[] = []
  let lastPersistedAt = 0
  const flush = () => {
    if (!pendingLogs.length && !pendingOutput.length) return
    const logs = pendingLogs.splice(0)
    const output = pendingOutput.splice(0)
    lastPersistedAt = Date.now()
    const updated = updateRecord(input.id, (current) => ({
      ...current,
      status: "running commands",
      progress: 0,
      lastAction: logs.at(-1) ?? current.lastAction,
      lastActivityAt: now(),
      // Runs before the reversals below: `logs` is a live array and .reverse()
      // mutates in place, which would make the transcript read backwards.
      turns: extendStreamTail(current.turns, input.turnId, logs),
      logs: [...[...logs].reverse(), ...current.logs].slice(0, 120),
      terminalOutput: [...[...output].reverse(), ...current.terminalOutput].slice(0, 240),
    }))
    syncBackgroundTask(updated, updated.lastAction)
  }

  const result = await runExternalCodingAgent({
    runtime: input.record.runtime as CodingAgentRuntime,
    cwd: input.record.isolatedPath,
    prompt: input.prompt,
    resumeSessionId: input.resumeSessionId,
    signal: input.controller.signal,
    // Persisted the moment it appears rather than at close: a crash or a user
    // stop mid-turn must still leave a resumable conversation behind.
    onSessionId: (sessionId) => {
      updateRecord(input.id, (current) => ({ ...current, externalSessionId: sessionId }))
    },
    onEvent: (event) => {
      if (event.stream === "activity") pendingLogs.push(event.text)
      if (event.stream !== "activity") pendingOutput.push(event.text)
      if (Date.now() - lastPersistedAt >= 400) flush()
    },
  }).finally(flush)
  // A CLI that refused the resume FLAGS is not a failed task — the caller
  // retries without resume rather than reporting a broken agent.
  if (result.resumeRejected) return result
  if (result.exitCode !== 0) {
    // agentOutcome already classified this failure — "installed but not signed
    // in", "exited with code N" — and that sentence is the only part the user
    // can act on. Throwing the raw stream-json tail instead buried it, so a
    // signed-out CLI read as "Vector is broken" rather than "run `claude`".
    const tail = result.output.slice(-12).join("\n").trim()
    throw new Error(
      result.error?.trim() ||
        `${runtimeLabel(input.record.runtime)} exited with code ${result.exitCode}.\n${tail}`.trim(),
    )
  }
  return result
}

async function executeExternalParallelWorkspace(
  id: string,
  initial: ParallelWorkspaceRecord,
  controller: AbortController,
  runId: string,
  followUp?: string,
) {
  const resumeSessionId = followUp ? initial.externalSessionId : undefined
  const turnId = randomUUID()
  let record = updateRecord(id, (current) => ({
    ...current,
    agentSessionId: undefined,
    // A fresh run is a NEW conversation; a follow-up must keep the id or it
    // restarts from nothing instead of resuming.
    externalSessionId: followUp ? current.externalSessionId : undefined,
    status: "editing",
    progress: 0,
    lastAction: followUp
      ? `${runtimeLabel(current.runtime)} is working on your message`
      : `${runtimeLabel(current.runtime)} is inspecting the isolated project`,
    lastActivityAt: now(),
    error: undefined,
    turns: followUp
      ? appendTurn(current.turns, {
          id: turnId,
          role: "agent",
          text: "",
          at: now(),
          state: "running",
          resumed: Boolean(resumeSessionId),
        })
      : [
          { id: randomUUID(), role: "user", text: current.taskPrompt, at: now(), state: "done" },
          { id: turnId, role: "agent", text: "", at: now(), state: "running", resumed: false },
        ],
    logs: [
      followUp
        ? resumeSessionId
          ? `${runtimeLabel(current.runtime)} resumed its existing conversation.`
          : `${runtimeLabel(current.runtime)} could not resume, so the follow-up restates the task.`
        : `${runtimeLabel(current.runtime)} started in ${current.isolatedPath}.`,
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(record, record.lastAction)

  const costs: number[] = []
  const beforeDiff = record.diff
  // External CLIs have no send_teammate_message tool — a real `claude -p` run
  // exposes 28 tools and none of them is it — so they cannot send. They do take
  // a prompt, so they can still RECEIVE what teammates queued for them, which is
  // the honest half of the capability rather than silently neither. Claimed
  // exactly once here because withTeammateMessages is destructive, and the
  // resume-rejected retry below must not re-claim and drop messages the refused
  // attempt never delivered.
  const delivery = withTeammateMessages(record, "")
  const briefBody = () =>
    continuationPrompt({
      missionBrief: parallelAgentPrompt(record),
      previousSummary: record.finalSummary,
      changedFiles: record.changedFiles,
      instruction: followUp ?? "",
    })
  const compose = (body: string) => [delivery, body].filter(Boolean).join("\n\n")

  const attempt = await runExternalWorkspacePass({
    id,
    record,
    turnId,
    controller,
    resumeSessionId,
    prompt: followUp ? compose(resumeSessionId ? followUp : briefBody()) : compose(parallelAgentPrompt(record)),
  })

  // The CLI refused the resume flags — cursor is unverified, and a CLI upgrade
  // can retire a flag. Re-brief once, and forget the id so later turns do not
  // pay for the same rejection again.
  const firstRun = attempt.resumeRejected
    ? await runExternalWorkspacePass({
        id,
        record: updateRecord(id, (current) => ({
          ...current,
          externalSessionId: undefined,
          // The turn was opened claiming a resume. The CLI refused it, so the
          // transcript has to stop claiming the agent remembers anything.
          turns: (current.turns ?? []).map((turn) => (turn.id === turnId ? { ...turn, resumed: false } : turn)),
          logs: [
            `${runtimeLabel(current.runtime)} would not resume the previous conversation, so Vector restarted it with a written summary of the work so far.`,
            ...current.logs,
          ].slice(0, 120),
        })),
        turnId,
        controller,
        prompt: compose(briefBody()),
      })
    : attempt
  if (firstRun.actualCost) costs.push(Number(firstRun.actualCost.replace("$", "")))

  record = updateRecord(id, (current) => ({
    ...current,
    turns: settleTurn(current.turns, turnId, {
      text: firstRun.summary,
      state: "done",
      cost: firstRun.actualCost,
    }),
  }))

  // A follow-up is often a question, not an edit. Running the whole check suite
  // to answer "which file did you touch?" would make the chat unusable, so the
  // guardrails only run when the tree actually moved.
  if (followUp) {
    const answered = await refreshParallelWorkspace(id)
    if (answered.diff === beforeDiff) {
      const noopLedger = await spendLedger()
      await noopLedger.recordRunCost({
        projectPath: answered.sourcePath,
        runId,
        provider: answered.provider,
        model: answered.model,
        source: "parallel",
        totalCostUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : undefined,
      })
      const unchanged = updateRecord(id, (current) => ({
        ...current,
        status: current.changedFilesCount ? "needs review" : "complete",
        progress: 100,
        lastActivityAt: now(),
        lastAction: `${runtimeLabel(current.runtime)} replied with no file changes`,
        finalSummary: firstRun.summary,
        logs: ["No files changed on this turn, so the deterministic checks were skipped.", ...current.logs].slice(0, 120),
      }))
      syncBackgroundTask(unchanged, unchanged.lastAction)
      return
    }
  }

  record = updateRecord(id, (current) => ({
    ...current,
    status: "testing",
    progress: 0,
    lastAction: "Running deterministic project checks",
    lastActivityAt: now(),
  }))
  syncBackgroundTask(record, `${runtimeLabel(record.runtime)} completed. Running deterministic checks.`)

  let refreshed = await refreshParallelWorkspace(id)
  let validation = await validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles)
  await rememberValidation(refreshed, validation)
  record = updateRecord(id, (current) => ({
    ...current,
    validationReport: validation,
    validationPassed: validation.passed,
    terminalOutput: [...validationLogLines(validation), ...current.terminalOutput].slice(0, 240),
    lastAction: checksAction(validation),
    lastActivityAt: now(),
    logs: [`Guardrails: ${validationSummary(validation)}`, ...current.logs].slice(0, 120),
  }))
  syncBackgroundTask(record, validationSummary(validation))

  const retryLimit = record.retryLimit ?? (record.taskDifficulty === "complex" ? 2 : 1)
  for (let attempt = 1; !validation.passed && attempt <= retryLimit && !controller.signal.aborted; attempt += 1) {
    // What this repository already knows about this exact failure, read after
    // the run above was recorded so the count and the flakiness verdict include
    // it. Empty until a signature has been seen before, hence the filter below.
    const guidance = await priorFor(record.sourcePath, validation, [record.isolatedPath, record.sourcePath])
    const repairTurnId = randomUUID()
    record = updateRecord(id, (current) => ({
      ...current,
      status: "editing",
      riskLevel: "high",
      repairAttempts: attempt,
      turns: appendTurn(
        appendTurn(current.turns, {
          id: randomUUID(),
          role: "vector",
          text: `A deterministic check failed. Vector returned the exact failure for repair pass ${attempt} of ${retryLimit}.`,
          at: now(),
          state: "done",
        }),
        { id: repairTurnId, role: "agent", text: "", at: now(), state: "running", resumed: false },
      ),
      lastAction: `${runtimeLabel(current.runtime)} is repairing a failed check (${attempt}/${retryLimit})`,
      lastActivityAt: now(),
      logs: [
        ...(guidance ? ["Prior failures in this repository were included in the repair prompt."] : []),
        `Vector returned the exact failing check to ${runtimeLabel(current.runtime)} for repair pass ${attempt} of ${retryLimit}.`,
        ...current.logs,
      ].slice(0, 120),
    }))
    syncBackgroundTask(record, record.lastAction)
    // Deliberately a fresh, non-resumed spawn with the full mission brief: this
    // is the path verified working end-to-end today, and resume is not worth
    // changing it in the same change that introduces resume.
    const repair = await runExternalWorkspacePass({
      id,
      record,
      turnId: repairTurnId,
      controller,
      prompt: withTeammateMessages(
        record,
        [
          parallelAgentPrompt(record),
          followUp ? `The user's most recent follow-up request was: ${followUp}` : "",
          guidance,
          formatValidationForRepair(validation),
          `This is repair pass ${attempt} of ${retryLimit}. Diagnose the exact output, make only evidence-backed changes, and rerun the relevant check before finishing.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    })
    if (repair.actualCost) costs.push(Number(repair.actualCost.replace("$", "")))
    refreshed = await refreshParallelWorkspace(id)
    validation = await validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles)
    // The runtime's own account of the repair, so a check that now passes
    // records what actually fixed it instead of a bare file list.
    await rememberValidation(refreshed, validation, repair.summary)
    record = updateRecord(id, (current) => ({
      ...current,
      status: "testing",
      validationReport: validation,
      validationPassed: validation.passed,
      terminalOutput: [
        `--- Guardrail repair verification ${attempt}/${retryLimit} ---`,
        ...validationLogLines(validation),
        ...current.terminalOutput,
      ].slice(0, 280),
      turns: settleTurn(current.turns, repairTurnId, {
        text: repair.summary,
        state: "done",
        cost: repair.actualCost,
      }),
      lastAction: validation.passed
        ? `Repair ${attempt} verified by deterministic checks`
        : `Repair ${attempt} did not pass validation`,
      lastActivityAt: now(),
      logs: [`Repair verification ${attempt}/${retryLimit}: ${validationSummary(validation)}`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(record, record.lastAction)
  }

  refreshed = await refreshParallelWorkspace(id)
  const measuredCosts = costs.filter(Number.isFinite)
  const totalCost = measuredCosts.reduce((sum, value) => sum + value, 0)
  // The ledger the pre-flight allowance reads. A runtime that reported no cost
  // at all is recorded with no total, which the ledger marks unmeasured: a 0
  // would let unknown spend count as proof this run was free.
  const ledger = await spendLedger()
  await ledger.recordRunCost({
    projectPath: refreshed.sourcePath,
    runId,
    provider: refreshed.provider,
    model: refreshed.model,
    source: "parallel",
    totalCostUsd: measuredCosts.length ? totalCost : undefined,
  })
  const finalSummary = `${firstRun.summary}\n\nGuardrails: ${validationSummary(validation)}`
  const completed = updateRecord(id, (current) => ({
    ...current,
    status: current.changedFilesCount ? "needs review" : "complete",
    progress: 100,
    actualCost: totalCost > 0 ? `$${totalCost.toFixed(4)}` : current.actualCost,
    riskLevel: validation.passed ? current.riskLevel : "high",
    lastAction: current.changedFilesCount
      ? reviewAction(validation)
      : `${runtimeLabel(current.runtime)} completed with no file changes`,
    lastActivityAt: now(),
    finalSummary,
    error: validation.passed ? undefined : validation.failureSummary.slice(0, 12_000),
    logs: [
      `${runtimeLabel(current.runtime)} completed with ${current.changedFilesCount} changed file${current.changedFilesCount === 1 ? "" : "s"}. ${validationSummary(validation)}`,
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(completed, completed.lastAction)
}

async function executeParallelWorkspace(id: string, engine: ParallelWorkspaceEngine, controller: AbortController) {
  try {
    const persisted = readRecords().find((record) => record.id === id)
    if (!persisted) throw new Error("Parallel workspace was not found.")
    // One run is one execution of this workspace, not the workspace itself, so
    // a rerun gets its own per-run budget instead of inheriting a spent one.
    // The workspace id stays in front so a ledger row is traceable back here.
    const runId = `${id}:${Date.now()}`
    const ledger = await spendLedger()
    const allowance = await ledger.checkAllowance({ projectPath: persisted.sourcePath, runId, source: "parallel" })
    // Blocked means the money is already spent, so the agent must never start.
    // Throwing lands in the catch below, which is the same failed-record shape
    // every other pre-flight failure uses, so the reason reaches the UI.
    if (!allowance.allowed) {
      throw new Error(allowance.reason || "A spend limit blocked this parallel agent run.")
    }
    // A warning is information, not a gate: the run proceeds and the user gets
    // told how close the cap is.
    const warning = allowance.state === "warn" ? allowance.reason : undefined
    if (warning) {
      const warned = updateRecord(id, (current) => ({
        ...current,
        lastActivityAt: now(),
        logs: [warning, ...current.logs].slice(0, 120),
      }))
      syncBackgroundTask(warned, warning)
    }
    const followUp = activeRuns.get(id)?.followUp
    // ensureParallelWorkspaceIsolation rebuilds a missing tree from sourcePath
    // as a fresh copy, which would silently discard exactly the work being
    // followed up on. A follow-up has to fail loudly instead.
    if (followUp && !(await stat(persisted.isolatedPath).catch(() => undefined))) {
      throw new Error(
        "The isolated workspace folder is gone, so this agent cannot continue. Run the workspace again to start fresh.",
      )
    }
    const initial = await ensureParallelWorkspaceIsolation(persisted)
    // Started before either runtime branch: every member of a team has to be
    // swept while the others are still working, which is the only window in
    // which a queued message can reach anybody.
    startTeamSweep(initial)
    if (initial.runtime !== "vector") {
      const prepared = await prepareParallelWorkspaceContext(initial)
      await executeExternalParallelWorkspace(id, prepared, controller, runId, followUp)
      return
    }

    const createRequest = parallelSessionCreateRequest({
      workspaceId: initial.id,
      workspaceName: initial.name,
      isolatedPath: initial.isolatedPath,
      sourcePath: initial.sourcePath,
      parentSessionId: initial.parentSessionId,
      engineParentSessionId: initial.engineParentSessionId,
      provider: initial.provider,
      model: initial.model,
      agent: initial.agent,
    })
    const created = await engineRequest<{ id?: string }>(engine, createRequest.path, {
      method: "POST",
      body: createRequest.body,
      signal: controller.signal,
    })
    const sessionId = created?.id
    if (!sessionId) throw new Error("Vector's engine did not return a session ID for the isolated workspace.")
    const active = activeRuns.get(id)
    if (active) active.sessionId = sessionId

    let record = updateRecord(id, (current) => ({
      ...current,
      agentSessionId: sessionId,
      status: "planning",
      progress: 0,
      lastAction: "Preparing task-specific project context",
      lastActivityAt: now(),
      error: undefined,
      logs: [`Engine session ${sessionId} started in ${current.isolatedPath}.`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(record, "Vector agent session started in the isolated workspace.")

    record = await prepareParallelWorkspaceContext(record)
    record = updateRecord(id, (current) => ({
      ...current,
      status: "editing",
      lastAction: "Agent is inspecting the isolated project",
      lastActivityAt: now(),
    }))
    syncBackgroundTask(record, "Task context prepared; the Vector agent is now working.")

    await engineRequest(engine, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: { prompt: { text: withTeammateMessages(record, parallelAgentPrompt(record)) }, resume: true },
      signal: controller.signal,
    })
    record = updateRecord(id, (current) => ({
      ...current,
      status: "running commands",
      progress: 0,
      lastAction: "Agent is editing and validating the workspace",
      lastActivityAt: now(),
      logs: ["Task admitted by the Vector engine. Waiting for tool execution and validation.", ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(record, "Task admitted; agent tool execution is active.")

    await waitForEngineSessionIdle(id, sessionId, engine, controller.signal)

    const turnFailure = await engineTurnFailure(sessionId, engine, controller.signal)
    if (turnFailure) throw new Error(turnFailure)

    record = updateRecord(id, (current) => ({
      ...current,
      status: "testing",
      progress: 0,
      lastAction: "Running deterministic project checks",
      lastActivityAt: now(),
    }))
    syncBackgroundTask(record, "Agent became idle. Running deterministic checks in the isolated workspace.")

    let refreshed = await refreshParallelWorkspace(id)
    let validation = await validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles)
    await rememberValidation(refreshed, validation)
    record = updateRecord(id, (current) => ({
      ...current,
      validationReport: validation,
      validationPassed: validation.passed,
      terminalOutput: [...validationLogLines(validation), ...current.terminalOutput].slice(0, 160),
      lastAction: checksAction(validation),
      lastActivityAt: now(),
      logs: [`Guardrails: ${validationSummary(validation)}`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(record, validationSummary(validation))

    const retryLimit = record.retryLimit ?? (record.taskDifficulty === "complex" ? 2 : 1)
    for (let attempt = 1; !validation.passed && attempt <= retryLimit && !controller.signal.aborted; attempt += 1) {
      // What this repository already knows about this exact failure, read after
      // the run above was recorded so the count and the flakiness verdict
      // include it. Empty until a signature has been seen before.
      const guidance = await priorFor(record.sourcePath, validation, [record.isolatedPath, record.sourcePath])
      record = updateRecord(id, (current) => ({
        ...current,
        status: "editing",
        riskLevel: "high",
        repairAttempts: attempt,
        lastAction: `Agent is repairing deterministic validation failure (${attempt}/${retryLimit})`,
        lastActivityAt: now(),
        logs: [
          ...(guidance ? ["Prior failures in this repository were included in the repair prompt."] : []),
          `Vector returned the exact failing check to the agent for evidence-driven repair pass ${attempt} of ${retryLimit}.`,
          ...current.logs,
        ].slice(0, 120),
      }))
      syncBackgroundTask(record, `Repairing the failed deterministic check (${attempt}/${retryLimit}).`)
      await engineRequest(engine, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        method: "POST",
        body: {
          prompt: {
            // A repair pass is a turn like any other, so it is also a delivery
            // point. Leaving it out meant the one extra turn a run does get
            // still skipped whatever a teammate had queued in the meantime.
            text: withTeammateMessages(
              record,
              [
                guidance,
                formatValidationForRepair(validation),
                `This is repair pass ${attempt} of ${retryLimit}. Diagnose from the exact output, make only evidence-backed changes, and rerun the relevant check yourself before finishing.`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
          },
          resume: true,
        },
        signal: controller.signal,
      })
      await waitForEngineSessionIdle(id, sessionId, engine, controller.signal)

      // A repair pass that died on a provider error must not read as a repair
      // attempt that simply did not fix anything.
      const repairFailure = await engineTurnFailure(sessionId, engine, controller.signal)
      if (repairFailure) throw new Error(repairFailure)

      refreshed = await refreshParallelWorkspace(id)
      validation = await validateWorkspace(refreshed.isolatedPath, refreshed.changedFiles)
      // The agent's own account of this repair pass, so a check that now passes
      // records what actually fixed it rather than a bare list of edited files.
      const repairContext = await engineRequest<{ data?: unknown }>(
        engine,
        `/api/session/${encodeURIComponent(sessionId)}/context`,
        { signal: controller.signal },
      ).catch(() => undefined)
      await rememberValidation(refreshed, validation, collectText(repairContext?.data).at(-1) ?? "")
      record = updateRecord(id, (current) => ({
        ...current,
        status: "testing",
        validationReport: validation,
        validationPassed: validation.passed,
        terminalOutput: [
          `--- Guardrail repair verification ${attempt}/${retryLimit} ---`,
          ...validationLogLines(validation),
          ...current.terminalOutput,
        ].slice(0, 220),
        lastAction: validation.passed
          ? `Repair ${attempt} verified by deterministic checks`
          : `Repair ${attempt} did not pass validation`,
        lastActivityAt: now(),
        logs: [`Repair verification ${attempt}/${retryLimit}: ${validationSummary(validation)}`, ...current.logs].slice(0, 120),
      }))
      syncBackgroundTask(record, `Repair verification ${attempt}/${retryLimit}: ${validationSummary(validation)}`)
    }

    const context = await engineRequest<{ data?: unknown }>(
      engine,
      `/api/session/${encodeURIComponent(sessionId)}/context`,
      { signal: controller.signal },
    ).catch(() => undefined)
    const summaries = collectText(context?.data)
    refreshed = await refreshParallelWorkspace(id)
    // The engine reports no per-run cost for an isolated session today, so this
    // run is recorded with no total at all. The ledger marks that unmeasured —
    // a run whose spend is unknown, never a run that is known to be free.
    await ledger.recordRunCost({
      projectPath: refreshed.sourcePath,
      runId,
      provider: refreshed.provider,
      model: refreshed.model,
      source: "parallel",
    })
    const agentSummary =
      summaries.at(-1) ||
      (refreshed.changedFilesCount
        ? `The isolated agent changed ${refreshed.changedFilesCount} file${refreshed.changedFilesCount === 1 ? "" : "s"}. Review the diff before merging.`
        : "The isolated agent completed without producing a file diff.")
    const finalSummary = `${agentSummary}\n\nGuardrails: ${validationSummary(validation)}`
    const completed = updateRecord(id, (current) => ({
      ...current,
      status: current.changedFilesCount ? "needs review" : "complete",
      progress: 100,
      riskLevel: validation.passed ? current.riskLevel : "high",
      lastAction: current.changedFilesCount
        ? reviewAction(validation)
        : "Agent completed with no file changes",
      lastActivityAt: now(),
      finalSummary,
      error: validation.passed ? undefined : validation.failureSummary.slice(0, 12_000),
      logs: [
        `${current.changedFilesCount ? `Agent completed with ${current.changedFilesCount} changed file${current.changedFilesCount === 1 ? "" : "s"}.` : "Agent completed without changing files."} ${validationSummary(validation)}`,
        ...current.logs,
      ].slice(0, 120),
    }))
    syncBackgroundTask(completed, completed.lastAction)
    await drainTeamOutbox(completed)
    broadcastHandoff(completed, agentSummary)
  } catch (error) {
    const stopped = controller.signal.aborted
    // A failed or timed-out run must not leave the engine session running and
    // spending the user's API keys in the background.
    const active = activeRuns.get(id)
    if (active?.sessionId && !stopped) {
      await engineRequest(engine, `/api/session/${encodeURIComponent(active.sessionId)}/interrupt`, {
        method: "POST",
      }).catch(() => undefined)
    }
    const detail = stopped
      ? "The parallel agent was stopped by the user."
      : error instanceof Error
        ? error.message
        : String(error)
    // A workspace can be discarded while its agent is still running, and then
    // this bookkeeping has nothing left to write to. updateRecord throws on a
    // missing id, so without this the failure handler itself raised an
    // unhandled rejection out of a background run.
    if (!readRecords().some((record) => record.id === id)) return
    const failed = updateRecord(id, (current) => ({
      ...current,
      status: stopped ? "stopped" : "failed",
      progress: 0,
      lastAction: stopped ? "Workspace stopped" : "Agent execution failed",
      lastActivityAt: now(),
      // Load-bearing: without it a spend-cap block or a signed-out CLI leaves a
      // spinner in the transcript, which reads as "my message broke this".
      turns: settleRunningTurns(current.turns, { state: stopped ? "stopped" : "failed", text: detail }),
      error: stopped ? undefined : detail,
      finalSummary: detail,
      logs: [detail, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(failed, detail)
  } finally {
    // An aborted or failed run would otherwise strand whatever it wrote, so the
    // outbox is drained on every exit path, not only the success path.
    const settled = readRecords().find((record) => record.id === id)
    if (settled) {
      await drainTeamOutbox(settled).catch(() => undefined)
      stopTeamSweep(settled)
    }
    activeRuns.delete(id)
    drainParallelRunQueue()
  }
}

export async function runParallelWorkspace(id: string, engine: ParallelWorkspaceEngine, concurrency?: number) {
  const existingRun = activeRuns.get(id)
  if (existingRun || queuedRuns.has(id)) return readRecords().find((record) => record.id === id)
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  if (current.mergeState !== "none") throw new Error("Merged or discarded workspaces cannot be run again.")

  // Only an explicit concurrency choice may retune the shared pool; an
  // undefined value must not stomp a swarm that is already draining.
  if (concurrency !== undefined) maxConcurrentRuns = normalizeConcurrency(concurrency)
  const controller = new AbortController()
  queuedRuns.set(id, { controller, engine })
  const queued = updateRecord(id, (record) => ({
    ...record,
    status: "queued",
    progress: 0,
    lastAction:
      activeRuns.size < maxConcurrentRuns
        ? `Starting isolated ${runtimeLabel(record.runtime)} session`
        : "Queued for an agent slot",
    lastActivityAt: now(),
    error: undefined,
    logs: [`Run requested at ${now()}.`, ...record.logs].slice(0, 120),
  }))
  syncBackgroundTask(queued, `Parallel agent queued for ${runtimeLabel(queued.runtime)}.`)
  drainParallelRunQueue()
  return readRecords().find((record) => record.id === id) ?? queued
}

// A follow-up is another pass on the same record, so it goes through the same
// queue as a run: concurrency, abort, the ledger pre-flight and the restart
// sweep all keep working with no second code path.
export async function followUpParallelWorkspace(id: string, engine: ParallelWorkspaceEngine, text: string) {
  const instruction = text.trim()
  if (!instruction) throw new Error("Type a message before sending it to the agent.")
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  if (current.runtime === "vector") throw new Error("Vector agents continue in their own chat session.")
  if (current.mergeState !== "none") throw new Error("Merged or discarded workspaces cannot be continued.")
  // runParallelWorkspace returns silently when a run is in flight; a typed
  // message must never be dropped without the user being told.
  if (activeRuns.has(id) || queuedRuns.has(id)) {
    throw new Error("This agent is still working. Wait for the current turn to finish, or stop it first.")
  }
  if (!(await stat(current.isolatedPath).catch(() => undefined))) {
    throw new Error(
      "This workspace's isolated folder is gone, so the conversation cannot continue. Run it again to start a new one.",
    )
  }

  const controller = new AbortController()
  // Registered BEFORE any status write: listParallelWorkspaces rewrites a
  // running record it cannot find in these maps to "failed", and the renderer
  // polls that list every 1.5s.
  queuedRuns.set(id, { controller, engine, followUp: instruction })
  const queued = updateRecord(id, (record) => ({
    ...record,
    status: "queued",
    progress: 0,
    error: undefined,
    lastAction: activeRuns.size < maxConcurrentRuns ? "Sending your message to the agent" : "Queued for an agent slot",
    lastActivityAt: now(),
    turns: appendTurn(record.turns, {
      id: randomUUID(),
      role: "user",
      text: instruction,
      at: now(),
      state: "done",
    }),
    logs: [`Follow-up message sent at ${now()}.`, ...record.logs].slice(0, 120),
  }))
  syncBackgroundTask(queued, `Follow-up message queued for ${runtimeLabel(queued.runtime)}.`)
  drainParallelRunQueue()
  return readRecords().find((record) => record.id === id) ?? queued
}

export async function stopParallelWorkspace(id: string) {
  const active = activeRuns.get(id)
  const queued = queuedRuns.get(id)
  queuedRuns.delete(id)
  active?.controller.abort()
  queued?.controller.abort()
  if (active?.sessionId) {
    await engineRequest(active.engine, `/api/session/${encodeURIComponent(active.sessionId)}/interrupt`, {
      method: "POST",
    }).catch(() => undefined)
  }
  const current = readRecords().find((record) => record.id === id)
  if (!current) throw new Error("Parallel workspace was not found.")
  // Stopping is only meaningful for work in flight; settled records
  // (needs review, complete, failed) keep their status.
  if (!active && !queued) return current
  const stoppedAt = now()
  const updated = updateRecord(id, (record) => ({
    ...record,
    status: "stopped",
    lastAction: "Workspace stopped",
    lastActivityAt: stoppedAt,
    logs: [`Stopped at ${stoppedAt}.`, ...record.logs].slice(0, 80),
  }))
  if (updated.backgroundTaskId) {
    try {
      cancelBackgroundTask(updated.backgroundTaskId)
    } catch {
      syncBackgroundTask(updated, "Parallel workspace task was stopped.")
    }
  }
  return updated
}

async function createCheckpoint(record: ParallelWorkspaceRecord) {
  const checkpointDir = join(workspaceRoot(), "main-checkpoints", record.id, `before-merge-${Date.now()}`)
  await mkdir(checkpointDir, { recursive: true })
  const checkpointPath = join(checkpointDir, "main-state.patch")
  if (await gitRoot(record.sourcePath)) {
    // HEAD-relative diff captures staged AND unstaged main-project changes;
    // the plain worktree diff used before silently missed staged work.
    const diff = await runGit(["diff", "--binary", "HEAD", "--"], record.sourcePath, { allowFailure: true })
    await writeFile(checkpointPath, diff.stdout || "# Main workspace had no git diff before merge.\n", "utf8")
    await writeFile(
      join(checkpointDir, "README.md"),
      [
        "# Vector merge checkpoint",
        "",
        "`main-state.patch` is the main project's staged+unstaged diff against HEAD taken right before this merge.",
        "Files in `overwritten/` are copies of untracked main-project files this merge replaced.",
        "To undo the merge's effect on a previously untracked file, copy it back from `overwritten/`.",
        "",
      ].join("\n"),
      "utf8",
    )
  } else {
    // A non-git project has no diff to capture, so the only thing that can
    // restore it is a copy of each file the merge is about to touch. The hash
    // map is kept for conflict detection but it is not a backup — it was the
    // whole of the "checkpoint" before, which meant a copy-mode merge could
    // delete untracked work irrecoverably.
    await Promise.all(
      (record.changedFiles ?? []).map((file) => backupBeforeOverwrite(checkpointPath, record.sourcePath, file)),
    )
    await writeFile(
      join(checkpointDir, "baseline-hashes.json"),
      JSON.stringify(record.baselineHashes ?? {}, null, 2),
      "utf8",
    )
    await writeFile(
      checkpointPath,
      "# This project is not a git repository, so there is no diff to capture.\n# Pre-merge copies of every affected file are in `overwritten/`.\n",
      "utf8",
    )
    await writeFile(
      join(checkpointDir, "README.md"),
      [
        "# Vector merge checkpoint",
        "",
        "This project is not a git repository, so Vector copied every file this merge",
        "was about to change or delete into `overwritten/` before touching anything.",
        "",
        "To undo the merge for a file, copy it back from `overwritten/` over the version",
        "in your project. `baseline-hashes.json` records what Vector believed each file",
        "looked like when the workspace was created.",
        "",
      ].join("\n"),
      "utf8",
    )
  }
  return checkpointPath
}

async function fileContentsEqual(a: string, b: string) {
  const [hashA, hashB] = await Promise.all([hashFile(a).catch(() => "a"), hashFile(b).catch(() => "b")])
  return hashA === hashB
}

// After a completed merge or discard nothing runs in the isolated checkout
// again, so remove the worktree, its branch, and the per-run directory. The
// record keeps the diff text and logs as durable history.
async function cleanupIsolation(record: ParallelWorkspaceRecord) {
  // A shared tree belongs to the team, not to one member. Removing it here
  // would delete a checkout teammates are still working in, and for a
  // shared-main workspace `dirname(isolatedPath)` is the parent of the user's
  // own repository. Neither is ever safe to remove on one agent finishing.
  if (record.teamId || record.isolatedPath === record.sourcePath) return
  if (record.isolation === "git-worktree") {
    await runGit(["worktree", "remove", "--force", record.isolatedPath], record.sourcePath, {
      allowFailure: true,
    }).catch(() => undefined)
    if (record.gitBranch) {
      await runGit(["branch", "-D", record.gitBranch], record.sourcePath, { allowFailure: true }).catch(() => undefined)
    }
  }
  await rm(dirname(record.isolatedPath), { recursive: true, force: true }).catch(() => undefined)
}

async function mergeGitWorktree(record: ParallelWorkspaceRecord, force: boolean, checkpointPath: string) {
  const patch = (await runGit(["diff", "--binary", record.baseCommit ?? "HEAD", "--"], record.isolatedPath, { allowFailure: true })).stdout
  const untracked = (
    await runGit(["ls-files", "--others", "--exclude-standard"], record.isolatedPath, { allowFailure: true })
  ).stdout
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)

  // An untracked file in the worktree may collide with the user's own
  // uncommitted-untracked file in main. Overwriting silently is data loss —
  // `git diff` checkpoints never capture untracked content.
  const collisions: string[] = []
  for (const file of untracked) {
    const target = join(record.sourcePath, file)
    const exists = await stat(target).catch(() => undefined)
    if (exists && !(await fileContentsEqual(join(record.isolatedPath, file), target))) collisions.push(file)
  }
  if (collisions.length && !force) {
    throw new Error(
      `Merge blocked: ${collisions.slice(0, 8).join(", ")} exist${collisions.length === 1 ? "s" : ""} in your main project with different content. Review or force-merge to overwrite (a backup copy is saved to the checkpoint).`,
    )
  }

  if (patch.trim()) {
    const check = await runGit(["apply", "--3way", "--check", "-"], record.sourcePath, {
      allowFailure: true,
      input: patch,
    })
    if (check.failed && !force) {
      throw new Error(`Merge conflict detected. Review before forcing merge.\n${check.stderr.trim()}`)
    }
    const applied = await runGit(["apply", "--3way", "-"], record.sourcePath, { allowFailure: true, input: patch })
    if (applied.failed) throw new Error(applied.stderr || "Git could not apply the workspace diff.")
  }

  for (const file of untracked) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    await backupBeforeOverwrite(checkpointPath, record.sourcePath, file)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
  }
}

async function mergeCopy(record: ParallelWorkspaceRecord, force: boolean, checkpointPath: string) {
  const refreshed = await refreshParallelWorkspace(record.id)
  const conflicts: string[] = []
  for (const file of refreshed.changedFiles) {
    const sourceHash = await hashFile(join(record.sourcePath, file)).catch(() => "missing")
    const baselineHash = record.baselineHashes?.[file] ?? "missing"
    if (sourceHash !== baselineHash) conflicts.push(file)
  }
  if (conflicts.length && !force) {
    throw new Error(
      `Merge conflict detected in ${conflicts.slice(0, 8).join(", ")}. Main project changed since workspace creation.`,
    )
  }
  for (const file of refreshed.changedFiles) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    const fromStat = await stat(from).catch(() => undefined)
    // Every path below either deletes or overwrites a file in the user's real
    // project, so the current contents are copied into the checkpoint first.
    // Without this a copy-mode merge destroyed untracked work with no way back:
    // for a non-git project the checkpoint held only hashes.
    await backupBeforeOverwrite(checkpointPath, record.sourcePath, file)
    if (!fromStat) {
      await rm(to, { force: true, recursive: true })
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
  }
}

async function validateBeforeIntegration(record: ParallelWorkspaceRecord, allowSecrets = false) {
  const secrets = await scanChangedSecrets(record.sourcePath, record.isolatedPath, record.changedFiles)
  if (secrets.length && !allowSecrets) {
    const summary = secrets
      .slice(0, 8)
      .map((finding) => `${finding.file}:${finding.line} (${finding.kind})`)
      .join(", ")
    const updated = updateRecord(record.id, (current) => ({
      ...current,
      status: "needs review",
      riskLevel: "high",
      lastAction: "Secret scan requires review",
      lastActivityAt: now(),
      error: `Potential credentials detected: ${summary}`,
      logs: [`Secret scan blocked integration: ${summary}`, ...current.logs].slice(0, 120),
    }))
    syncBackgroundTask(updated, "Potential credentials must be reviewed before integration.")
    throw new Error(
      `Secret scan blocked integration. Review ${summary}. Vector never includes secret values in this report; explicitly confirm the force action only if these are intentional test credentials.`,
    )
  }
  const validationReport = await validateWorkspace(record.isolatedPath, record.changedFiles)
  const updated = updateRecord(record.id, (current) => ({
    ...current,
    validationReport,
    validationPassed: validationReport.passed,
    terminalOutput: [...validationLogLines(validationReport), ...current.terminalOutput].slice(0, 160),
    lastActivityAt: now(),
    logs: [`Pre-merge checks: ${validationSummary(validationReport)}`, ...current.logs].slice(0, 120),
  }))
  syncBackgroundTask(updated, validationSummary(validationReport))
  if (!validationReport.passed) {
    throw new Error(validationReport.failureSummary || "Workspace checks failed. Fix them before integrating these changes.")
  }
  return updated
}

export async function mergeParallelWorkspace(
  id: string,
  force = false,
  commit?: { message: string },
) {
  const refreshed = await refreshParallelWorkspace(id)
  if (refreshed.mergeState === "merged") return refreshed
  if (refreshed.mergeState === "discarded") throw new Error("Discarded workspaces cannot be merged.")
  if (!refreshed.changedFiles.length) throw new Error("There are no changes to merge.")
  const record = await validateBeforeIntegration(refreshed, force)
  const checkpointPath = await createCheckpoint(record)
  try {
    if (record.isolation === "git-worktree") await mergeGitWorktree(record, force, checkpointPath)
    else await mergeCopy(record, force, checkpointPath)
  } catch (error) {
    const failed = updateRecord(id, (current) => ({
      ...current,
      status: "failed",
      lastAction: "Merge blocked",
      lastActivityAt: now(),
      checkpointPath,
      error: error instanceof Error ? error.message : String(error),
      logs: [`Merge blocked: ${error instanceof Error ? error.message : String(error)}`, ...current.logs].slice(0, 80),
    }))
    syncBackgroundTask(failed, "Merge was blocked by a conflict or failed patch.")
    return failed
  }
  await cleanupIsolation(record)

  // Optional real commit: the merge already landed in main's working tree
  // (checkpoint + untracked backups preserved). Committing is a separate,
  // reversible step (git reset --soft HEAD~1), so a commit failure must never
  // discard the successful merge — it is recorded and surfaced instead.
  let commitNote = ""
  let commitError = ""
  if (commit?.message?.trim()) {
    try {
      if (!(await gitRoot(record.sourcePath))) {
        commitError = "Changes were merged, but the main project is not a git repository, so nothing was committed."
      } else if (await gitIsClean(record.sourcePath)) {
        commitNote = "Main working tree was already clean after the merge; nothing to commit."
      } else {
        await runGit(["add", "-A"], record.sourcePath)
        await runGit(await buildCommitArgs(record.sourcePath, commit.message.trim()), record.sourcePath)
        const sha = (
          await runGit(["rev-parse", "--short", "HEAD"], record.sourcePath, { allowFailure: true })
        ).stdout.trim()
        commitNote = sha ? `Committed to main: ${sha}` : "Committed to main."
      }
    } catch (error) {
      commitError = `Merge succeeded, but the git commit failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const merged = updateRecord(id, (current) => ({
    ...current,
    status: "merged",
    progress: 100,
    mergeState: "merged",
    checkpointPath,
    error: commitError || undefined,
    lastAction: commitNote.startsWith("Committed") ? "Merged and committed to the main project" : "Merged into main project",
    lastActivityAt: now(),
    finalSummary: [
      `Merged ${current.changedFiles.length} changed file${current.changedFiles.length === 1 ? "" : "s"} into the main project.`,
      commitNote,
      commitError,
    ]
      .filter(Boolean)
      .join(" "),
    logs: [
      `Merged at ${now()}. Worktree cleaned up. Main checkpoint: ${checkpointPath}`,
      ...(commitNote ? [commitNote] : []),
      ...(commitError ? [commitError] : []),
      ...current.logs,
    ].slice(0, 80),
  }))
  syncBackgroundTask(
    merged,
    commitError
      ? "Merged into the main project, but the commit failed."
      : commitNote.startsWith("Committed")
        ? "Parallel workspace merged and committed to the main project."
        : "Parallel workspace merged into the main project.",
  )
  return merged
}

export async function openParallelWorkspacePullRequest(id: string) {
  const refreshed = await refreshParallelWorkspace(id)
  if (refreshed.mergeState !== "none") throw new Error("This workspace is already closed.")
  if (refreshed.isolation !== "git-worktree" || !refreshed.gitBranch) {
    throw new Error("Pull requests require a Git project with an isolated worktree.")
  }
  if (!refreshed.changedFiles.length) throw new Error("There are no workspace changes to open as a pull request.")
  const record = await validateBeforeIntegration(refreshed)
  const result = await createPullRequest({
    projectPath: record.isolatedPath,
    title: record.name,
    body: [record.finalSummary, "", `Vector task: ${record.taskPrompt}`].filter(Boolean).join("\n"),
  })
  if (!result.ok || !result.url) throw new Error(result.error || "GitHub did not return a pull request URL.")
  const updated = updateRecord(id, (current) => ({
    ...current,
    pullRequestUrl: result.url,
    lastAction: "Pull request ready for review",
    lastActivityAt: now(),
    logs: [`Opened pull request: ${result.url}`, ...current.logs].slice(0, 120),
  }))
  syncBackgroundTask(updated, "Workspace pull request opened on GitHub.")
  return updated
}

async function mergeSelectedGitChanges(
  record: ParallelWorkspaceRecord,
  selection: UnifiedDiffSelection,
  force: boolean,
  checkpointPath: string,
) {
  const patch = (await runGit(["diff", "--binary", record.baseCommit ?? "HEAD", "--"], record.isolatedPath, { allowFailure: true }))
    .stdout
  // Hunk IDs were hashed from the diff snapshot the user reviewed. If the
  // workspace changed since, missing IDs must fail loudly instead of being
  // silently dropped while the log claims every approved hunk merged.
  if (selection.hunkIds?.length) {
    const freshIds = new Set(parseUnifiedDiff(patch).flatMap((file) => file.hunks.map((hunk) => hunk.id)))
    const missing = selection.hunkIds.filter((id) => !freshIds.has(id))
    if (missing.length) {
      throw new Error(
        `${missing.length} of ${selection.hunkIds.length} approved hunk${selection.hunkIds.length === 1 ? "" : "s"} no longer match the workspace diff. Refresh the review and approve again.`,
      )
    }
  }
  const selectedPatch = selectUnifiedDiff(patch, selection)
  const untracked = new Set(
    (
      await runGit(["ls-files", "--others", "--exclude-standard"], record.isolatedPath, {
        allowFailure: true,
      })
    ).stdout
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const selectedUntracked = (selection.files ?? []).filter((file) => untracked.has(file))

  if (!selectedPatch.trim() && !selectedUntracked.length) {
    throw new Error("Select at least one changed hunk or file before merging.")
  }

  if (selectedPatch.trim()) {
    const reverseCheck = await runGit(["apply", "--reverse", "--check", "-"], record.isolatedPath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (reverseCheck.failed) {
      throw new Error(`The selected diff is stale and can no longer be separated safely.\n${reverseCheck.stderr.trim()}`)
    }
    const sourceCheck = await runGit(["apply", "--3way", "--check", "-"], record.sourcePath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (sourceCheck.failed && !force) {
      throw new Error(`Selected changes conflict with the main project.\n${sourceCheck.stderr.trim()}`)
    }
    const applied = await runGit(["apply", "--3way", "-"], record.sourcePath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (applied.failed) throw new Error(applied.stderr || "Git could not apply the selected changes.")

    const removed = await runGit(["apply", "--reverse", "-"], record.isolatedPath, {
      allowFailure: true,
      input: selectedPatch,
    })
    if (removed.failed) {
      throw new Error(
        "The selected changes reached main, but Vector could not remove them from the isolated review. Refresh the workspace before merging again.",
      )
    }
  }

  for (const file of selectedUntracked) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    const exists = await stat(to).catch(() => undefined)
    if (exists && !(await fileContentsEqual(from, to)) && !force) {
      throw new Error(`Merge blocked: ${file} exists in your main project with different content.`)
    }
    await backupBeforeOverwrite(checkpointPath, record.sourcePath, file)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
    await rm(from, { force: true, recursive: true })
  }
}

async function mergeSelectedCopyChanges(
  record: ParallelWorkspaceRecord,
  selection: UnifiedDiffSelection,
  force: boolean,
  checkpointPath: string,
) {
  if (selection.hunkIds?.length) {
    throw new Error("Non-Git projects support selective review one complete file at a time.")
  }
  const refreshed = await refreshParallelWorkspace(record.id)
  const changed = new Set(refreshed.changedFiles)
  const files = Array.from(new Set(selection.files ?? [])).filter((file) => changed.has(file))
  if (!files.length) throw new Error("Select at least one changed file before merging.")

  const conflicts: string[] = []
  for (const file of files) {
    const sourceHash = await hashFile(join(record.sourcePath, file)).catch(() => "missing")
    const baselineHash = record.baselineHashes?.[file] ?? "missing"
    if (sourceHash !== baselineHash) conflicts.push(file)
  }
  if (conflicts.length && !force) {
    throw new Error(
      `Selected files conflict with newer main-project edits: ${conflicts.slice(0, 8).join(", ")}.`,
    )
  }

  const nextBaseline = { ...(record.baselineHashes ?? {}) }
  for (const file of files) {
    const from = join(record.isolatedPath, file)
    const to = join(record.sourcePath, file)
    const fromStat = await stat(from).catch(() => undefined)
    await backupBeforeOverwrite(checkpointPath, record.sourcePath, file)
    if (!fromStat) {
      await rm(to, { force: true, recursive: true })
      nextBaseline[file] = "missing"
      continue
    }
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to, { recursive: true, force: true })
    nextBaseline[file] = await hashFile(from).catch(() => "missing")
  }
  updateRecord(record.id, (current) => ({ ...current, baselineHashes: nextBaseline }))
}

export async function mergeParallelWorkspaceSelection(
  id: string,
  selection: UnifiedDiffSelection,
  force = false,
) {
  const refreshed = await refreshParallelWorkspace(id)
  if (refreshed.mergeState !== "none") throw new Error("This workspace is no longer available for review.")
  if (!refreshed.changedFiles.length) throw new Error("There are no changes to merge.")
  const record = await validateBeforeIntegration(refreshed, force)
  const checkpointPath = await createCheckpoint(record)

  try {
    if (record.isolation === "git-worktree") await mergeSelectedGitChanges(record, selection, force, checkpointPath)
    else await mergeSelectedCopyChanges(record, selection, force, checkpointPath)
  } catch (error) {
    const failed = updateRecord(id, (current) => ({
      ...current,
      status: "needs review",
      lastAction: "Selective merge blocked",
      lastActivityAt: now(),
      checkpointPath,
      error: error instanceof Error ? error.message : String(error),
      logs: [
        `Selective merge blocked: ${error instanceof Error ? error.message : String(error)}`,
        ...current.logs,
      ].slice(0, 120),
    }))
    syncBackgroundTask(failed, "Selective merge was blocked; the isolated changes remain available.")
    return failed
  }

  const remaining = await refreshParallelWorkspace(id)
  const acceptedCount = (selection.hunkIds?.length ?? 0) + (selection.files?.length ?? 0)
  const complete = remaining.changedFiles.length === 0
  if (complete) await cleanupIsolation(remaining)
  const updated = updateRecord(id, (current) => ({
    ...current,
    status: complete ? "merged" : "needs review",
    progress: complete ? 100 : current.progress,
    mergeState: complete ? "merged" : "none",
    checkpointPath,
    error: undefined,
    lastAction: complete ? "All approved changes merged" : "Approved changes merged; review remains",
    lastActivityAt: now(),
    finalSummary: complete
      ? "All approved changes were merged into the main project."
      : `${current.changedFiles.length} changed file${current.changedFiles.length === 1 ? "" : "s"} remain in isolated review.`,
    logs: [
      `Merged ${acceptedCount} approved review item${acceptedCount === 1 ? "" : "s"} at ${now()}. Checkpoint: ${checkpointPath}`,
      ...current.logs,
    ].slice(0, 120),
  }))
  syncBackgroundTask(updated, complete ? "Workspace review fully merged." : "Approved changes merged; review remains.")
  return updated
}

export async function discardParallelWorkspace(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) throw new Error("Parallel workspace was not found.")
  // Deleting a live agent's directory out from under it keeps the engine
  // session running (and spending tokens) against a removed path — stop the
  // run before touching the filesystem.
  const active = activeRuns.get(id)
  const queued = queuedRuns.get(id)
  queuedRuns.delete(id)
  active?.controller.abort()
  queued?.controller.abort()
  if (active?.sessionId) {
    await engineRequest(active.engine, `/api/session/${encodeURIComponent(active.sessionId)}/interrupt`, {
      method: "POST",
    }).catch(() => undefined)
  }
  await cleanupIsolation(record)
  const discarded = updateRecord(id, (current) => ({
    ...current,
    status: "discarded",
    progress: 100,
    mergeState: "discarded",
    lastAction: "Discarded isolated workspace",
    lastActivityAt: now(),
    logs: [`Discarded at ${now()}.`, ...current.logs].slice(0, 80),
  }))
  syncBackgroundTask(discarded, "Parallel workspace discarded.")
  return discarded
}

// Merged, discarded, failed, and stopped workspaces keep their record as
// history, but the list fills the launch cap over time. Removal deletes the
// record (never a live run) so the workspace list stays usable.
export async function removeParallelWorkspaceRecord(id: string) {
  const record = readRecords().find((item) => item.id === id)
  if (!record) return readRecords()
  if (activeRuns.has(id) || queuedRuns.has(id)) {
    throw new Error("Stop this workspace before removing it from the list.")
  }
  if (record.mergeState === "none" && ["needs review", "complete"].includes(record.status) && record.changedFilesCount > 0) {
    throw new Error("This workspace still has unreviewed changes. Merge or discard it first.")
  }
  await cleanupIsolation(record)
  const next = readRecords().filter((item) => item.id !== id)
  writeRecords(next)
  if (record.backgroundTaskId) {
    try {
      cancelBackgroundTask(record.backgroundTaskId)
    } catch {
      // The mirrored task may already be settled; removal proceeds regardless.
    }
  }
  return next
}
