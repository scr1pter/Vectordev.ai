import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, cp, mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { app } from "electron"

// Detection + handoff plumbing for external coding agents/editors Vector can
// host or hand a task off to. Read-only probing (no shell:true, fixed
// binaries) so this never executes anything the user didn't already install.

export type ExternalAgentId = "claude-code" | "codex" | "cursor" | "vscode"
export type CodingAgentRuntime = "claude-code" | "codex" | "cursor"

export type ExternalAgentStatus = {
  id: ExternalAgentId
  name: string
  cli: string
  installed: boolean
  version?: string
  path?: string
}

type ExternalAgentCandidate = { id: ExternalAgentId; name: string; cli: string }

const CANDIDATES: ExternalAgentCandidate[] = [
  { id: "claude-code", name: "Claude Code", cli: "claude" },
  { id: "codex", name: "Codex CLI", cli: "codex" },
  { id: "cursor", name: "Cursor Agent", cli: "cursor-agent" },
  { id: "vscode", name: "VS Code", cli: "code" },
]

type RunResult = { stdout: string; stderr: string; failed: boolean }

function run(command: string, args: string[], timeoutMs: number) {
  return new Promise<RunResult>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) })
    })
  })
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

async function resolvePath(cli: string): Promise<string | undefined> {
  const command = process.platform === "win32" ? "where" : "which"
  const result = await run(command, [cli], 5_000)
  if (!result.failed) return firstLine(result.stdout)
  const candidates =
    cli === "claude"
      ? [
          join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ]
      : cli === "codex"
        ? [
            join(homedir(), ".local", "bin", process.platform === "win32" ? "codex.exe" : "codex"),
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
          ]
        : cli === "cursor-agent"
          ? [
              join(homedir(), ".local", "bin", process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent"),
              "/opt/homebrew/bin/cursor-agent",
              "/usr/local/bin/cursor-agent",
            ]
          : []
  return (
    await Promise.all(
      candidates.map(async (path) => ((await access(path).then(() => true).catch(() => false)) ? path : undefined)),
    )
  ).find((path): path is string => Boolean(path))
}

async function resolveVersion(cli: string): Promise<string | undefined> {
  const result = await run(cli, ["--version"], 5_000)
  if (result.failed) return undefined
  return firstLine(result.stdout) ?? firstLine(result.stderr)
}

async function detectOne(candidate: ExternalAgentCandidate): Promise<ExternalAgentStatus> {
  const path = await resolvePath(candidate.cli)
  if (!path) return { id: candidate.id, name: candidate.name, cli: candidate.cli, installed: false }
  const version = await resolveVersion(path)
  return { id: candidate.id, name: candidate.name, cli: candidate.cli, installed: true, version, path }
}

// Detection spawns two short-lived processes per candidate; cache the result
// briefly so a re-render (or several) doesn't re-spawn `which`/`--version`.
const CACHE_TTL_MS = 60_000
let cache: { at: number; result: ExternalAgentStatus[] } | undefined

export async function detectExternalAgents(): Promise<ExternalAgentStatus[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  const result = await Promise.all(CANDIDATES.map(detectOne))
  cache = { at: Date.now(), result }
  return result
}

export type OpenInEditorApp = "cursor" | "vscode"

export type OpenInEditorInput = { app: OpenInEditorApp; path: string }

export type OpenInEditorResult = { ok: boolean; error?: string }

const EDITOR_CLIS: Record<OpenInEditorApp, string> = { cursor: "cursor", vscode: "code" }

export async function openInEditor(input: OpenInEditorInput): Promise<OpenInEditorResult> {
  const path = input?.path?.trim()
  if (!path) return { ok: false, error: "Choose a file or folder to open." }
  const stats = await stat(path).catch(() => undefined)
  if (!stats) return { ok: false, error: `"${path}" does not exist.` }

  const cli = EDITOR_CLIS[input.app]
  return new Promise((resolve) => {
    // The cursor/code CLIs hand off to the editor app and exit almost
    // immediately, so the launched editor never becomes Vector's child.
    const child = execFile(cli, [path], { timeout: 10_000 }, (error: Error | null) => {
      resolve(
        error
          ? { ok: false, error: `Couldn't launch ${cli}. Make sure it's installed and on your PATH.` }
          : { ok: true },
      )
    })
    child.unref()
  })
}

// Directories that never belong in an isolated agent checkout — heavyweight or
// machine-specific state that a headless agent should regenerate itself.
const WORKSPACE_EXCLUDED_DIRS = new Set([
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

const RUNS_DIRECTORY_NAME = "external-agent-runs"

export type PrepareWorkspaceResult = { path: string; isolation: "git-worktree" | "copy" }

function runIn(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<RunResult>((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) })
    })
  })
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const result = await runIn("git", ["rev-parse", "--show-toplevel"], cwd, 5_000)
  if (result.failed) return undefined
  return firstLine(result.stdout)
}

async function gitTreeClean(cwd: string): Promise<boolean> {
  const result = await runIn("git", ["status", "--porcelain"], cwd, 5_000)
  return !result.failed && result.stdout.trim().length === 0
}

async function copyProjectTree(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    dereference: false,
    filter: (entry) => !entry.split(/[\\/]/).some((part) => WORKSPACE_EXCLUDED_DIRS.has(part)),
  })
}

// Create an isolated working directory for a single external-agent run so the
// headless agent edits a checkout, never the user's live project. Prefers a git
// worktree (cheap, shares history) when the tree is a clean repo, and falls back
// to an excluded-dir copy for non-git or dirty trees — mirrors the isolation
// strategy in parallel-workspaces.ts, kept minimal for a one-shot run.
export async function prepareWorkspace(projectPath: string): Promise<PrepareWorkspaceResult> {
  const path = projectPath?.trim()
  if (!path) throw new Error("Open a project before running an external agent.")
  const stats = await stat(path).catch(() => undefined)
  if (!stats?.isDirectory()) throw new Error(`"${path}" is not a folder Vector can run an agent in.`)

  const runId = randomUUID()
  const runRoot = join(app.getPath("userData"), RUNS_DIRECTORY_NAME, runId)
  const isolatedPath = join(runRoot, "workspace")
  await mkdir(runRoot, { recursive: true })

  const gitRoot = await gitTopLevel(path)
  if (gitRoot && (await gitTreeClean(gitRoot))) {
    const branch = `vector-agent/${runId.slice(0, 8)}`
    const worktree = await runIn("git", ["worktree", "add", "-b", branch, isolatedPath, "HEAD"], gitRoot, 30_000)
    if (!worktree.failed) return { path: isolatedPath, isolation: "git-worktree" }
    // A failed worktree can leave a partial checkout behind; clear it before
    // falling back to a plain copy so the copy starts from a clean directory.
    await rm(isolatedPath, { recursive: true, force: true }).catch(() => undefined)
  }

  await copyProjectTree(gitRoot ?? path, isolatedPath)
  return { path: isolatedPath, isolation: "copy" }
}

export type ExternalAgentEvent = {
  stream: "activity" | "stdout" | "stderr"
  text: string
}

export type ExternalAgentRunResult = {
  exitCode: number
  summary: string
  actualCost?: string
  output: string[]
}

export type RunExternalAgentInput = {
  runtime: CodingAgentRuntime
  cwd: string
  prompt: string
  signal?: AbortSignal
  onEvent?: (event: ExternalAgentEvent) => void
}

const SECRET_VALUE_PATTERN =
  /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*["'=:\s]+\s*)([^\s"',}]+)/gi
const BEARER_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+/gi

function redactAgentOutput(value: string) {
  return value.replace(SECRET_VALUE_PATTERN, "$1[redacted]").replace(BEARER_PATTERN, "$1[redacted]")
}

function runtimeCandidate(runtime: CodingAgentRuntime) {
  return CANDIDATES.find((candidate) => candidate.id === runtime)!
}

function runtimeArguments(runtime: CodingAgentRuntime, cwd: string, prompt: string) {
  if (runtime === "claude-code") {
    return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]
  }
  if (runtime === "codex") {
    return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", cwd, prompt]
  }
  return ["-p", "--force", "--output-format", "stream-json", prompt]
}

function parseAgentJson(line: string) {
  if (!line.startsWith("{")) return undefined
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function textAt(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") return undefined
  return keys
    .map((key) => (value as Record<string, unknown>)[key])
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function activityFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  if (!event) return line
  const type = typeof event.type === "string" ? event.type : "event"
  const item = event.item && typeof event.item === "object" ? event.item : undefined
  const message =
    textAt(event, ["result", "message", "summary", "text"]) ??
    textAt(item, ["text", "message", "command", "path", "name"])
  return message ? `${type}: ${message}` : type.replace(/[._-]+/g, " ")
}

function summaryFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  if (!event) return undefined
  return (
    textAt(event, ["result", "summary", "final_output"]) ??
    (event.item && typeof event.item === "object" ? textAt(event.item, ["text", "message"]) : undefined)
  )
}

function costFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  const value = event?.total_cost_usd ?? event?.cost_usd
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : undefined
}

function stopAgentProcess(child: ChildProcessWithoutNullStreams) {
  if (child.killed) return
  if (process.platform === "win32") {
    child.kill("SIGTERM")
    return
  }
  if (!child.pid) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

export async function runExternalCodingAgent(input: RunExternalAgentInput): Promise<ExternalAgentRunResult> {
  const candidate = runtimeCandidate(input.runtime)
  const path = await resolvePath(candidate.cli)
  if (!path) {
    throw new Error(
      input.runtime === "cursor"
        ? "Cursor Agent is not installed. Install and sign in to cursor-agent before launching this runtime."
        : `${candidate.name} is not installed or is not available to Vector. Install and sign in to its CLI first.`,
    )
  }

  return new Promise((resolve, reject) => {
    const child = spawn(path, runtimeArguments(input.runtime, input.cwd, input.prompt), {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const output: string[] = []
    const summaries: string[] = []
    let actualCost: string | undefined
    let stdoutBuffer = ""
    let stderrBuffer = ""
    let settled = false

    const emitLine = (stream: "stdout" | "stderr", raw: string) => {
      const text = redactAgentOutput(raw.trim())
      if (!text) return
      output.push(`[${stream}] ${text}`)
      if (output.length > 240) output.shift()
      const summary = summaryFromAgentLine(text)
      if (summary) summaries.push(summary)
      actualCost = costFromAgentLine(text) ?? actualCost
      input.onEvent?.({ stream, text })
      input.onEvent?.({ stream: "activity", text: activityFromAgentLine(text) })
    }

    const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const combined = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString("utf8")
      const lines = combined.split(/\r?\n/)
      const remainder = lines.pop() ?? ""
      if (stream === "stdout") stdoutBuffer = remainder
      if (stream === "stderr") stderrBuffer = remainder
      lines.forEach((line) => emitLine(stream, line))
    }

    const abort = () => stopAgentProcess(child)
    input.signal?.addEventListener("abort", abort, { once: true })
    child.stdin.end()
    if (input.signal?.aborted) abort()
    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener("abort", abort)
      emitLine("stdout", stdoutBuffer)
      emitLine("stderr", stderrBuffer)
      const exitCode = code ?? (input.signal?.aborted ? 130 : 1)
      resolve({
        exitCode,
        summary:
          summaries.at(-1) ??
          (exitCode === 0
            ? `${candidate.name} completed the isolated task.`
            : `${candidate.name} exited with code ${exitCode}.`),
        actualCost,
        output,
      })
    })
  })
}
