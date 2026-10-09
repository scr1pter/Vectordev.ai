import { execFile } from "node:child_process"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

import { githubFetch, githubJson, parseGithubRemote, readTail, type GithubAccess } from "./github-api"
import { resolveGithubAccess } from "./github-access"
import { redactText } from "./security-redaction"

// Vector's read side of GitHub Actions: notice that the branch the user just
// pushed is red, pull only the failed steps out of a log that can be hundreds
// of megabytes, and turn that into a prompt an agent can act on. Every GitHub
// call goes through GitHub's API with the user's GitHub sign-in in Vector, the
// same access the Pull Requests panel uses, so nothing has to be installed.

export type CiUnavailableReason = "signed-out" | "not-a-repo" | "no-remote" | "no-branch" | "github-failed"

// Every failure path in this module resolves to one of these instead of
// throwing. What the user needs when CI is unreadable is the one step that
// makes it readable, and a rejected promise carries that badly. command is a
// shell command when one fixes it, and empty when the fix is signing in.
export type CiUnavailable = {
  ok: false
  reason: CiUnavailableReason
  detail: string
  command: string
}

export type CiRepo = { owner: string; name: string; branch: string; remote: string }

export type CiRun = {
  id: number
  number: number
  workflow: string
  title: string
  branch: string
  headSha: string
  event: string
  status: string
  conclusion: string
  url: string
  createdAt: string
}

export type CiFailureKind = "type-error" | "test-failure" | "lint" | "exit-code" | "unknown"

export type CiFailedStep = {
  job: string
  step: string
  kind: CiFailureKind
  command?: string
  exitCode?: number
  excerpt: string
}

export type CiFailure = {
  repo: string
  run: CiRun
  steps: CiFailedStep[]
  logTruncated: boolean
}

// A single failed step's excerpt is what actually reaches a model, so it stays
// small enough that several of them still fit alongside the repo's own context.
const MAX_EXCERPT_BYTES = 8 * 1024
const MAX_STEPS = 6
// A job's log holds every step, and only its tail is read, so this is also the
// most of a job log Vector ever holds in memory. Keeping the tail loses the
// "##[group]Run" header of a step bigger than this, which only costs us the
// echoed command.
export const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_FAILED_JOBS = 4
const CONTEXT_LINES = 3
const TRIM_MARKER_BYTES = 48
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"])

export async function ciStatus(projectPath: string): Promise<{ ok: true; repo: CiRepo } | CiUnavailable> {
  const context = await ciContext(projectPath)
  return context.ok ? { ok: true, repo: context.repo } : context
}

async function ciContext(
  projectPath: string,
): Promise<{ ok: true; repo: CiRepo; access: GithubAccess } | CiUnavailable> {
  const access = await resolveGithubAccess()
  if (!access) {
    return {
      ok: false,
      reason: "signed-out",
      detail: "Sign in to GitHub in Vector so it can read this repository's workflow runs.",
      command: "",
    }
  }
  const detected = await detectCiRepo(projectPath)
  return detected.ok ? { ...detected, access } : detected
}

export async function listCiRuns(
  projectPath: string,
  options?: { branch?: string; limit?: number },
): Promise<{ ok: true; repo: CiRepo; runs: CiRun[] } | CiUnavailable> {
  const context = await ciContext(projectPath)
  if (!context.ok) return context
  const branch = options?.branch?.trim() || context.repo.branch
  const limit = Math.max(1, Math.min(100, options?.limit ?? 20))
  const result = await githubJson<{ workflow_runs?: RawRun[] }>(
    context.access,
    `${repoPath(context.repo)}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${limit}`,
    { timeoutMs: 45_000 },
  ).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => failed(error, `GitHub could not list workflow runs for ${branch}.`),
  )
  if (!result.ok) return result
  return { ok: true, repo: { ...context.repo, branch }, runs: (result.value.workflow_runs ?? []).map(toRun) }
}

export async function viewCiFailure(
  projectPath: string,
  runId: number,
): Promise<{ ok: true; failure: CiFailure } | CiUnavailable> {
  const context = await ciContext(projectPath)
  if (!context.ok) return context
  const run = `${repoPath(context.repo)}/actions/runs/${Number(runId)}`
  const loaded = await Promise.all([
    githubJson<RawRun>(context.access, run, { timeoutMs: 45_000 }),
    githubJson<{ jobs?: RawJob[] }>(context.access, `${run}/jobs?per_page=100`, { timeoutMs: 45_000 }),
  ]).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => failed(error, `GitHub could not load run ${runId}.`),
  )
  if (!loaded.ok) return loaded
  const [raw, jobs] = loaded.value
  const failedJobs = (jobs.jobs ?? []).filter((job) => job.conclusion === "failure").slice(0, MAX_FAILED_JOBS)
  // Each failed job's log, reduced to its failing step. A run that failed to
  // start, or one whose logs GitHub has already expired, returns no log at all;
  // the job list still names what went red, which is worth more to the user
  // than an empty panel.
  const logs = await Promise.all(
    failedJobs.map(async (job) => {
      // GitHub answers with a redirect to a short-lived download URL, which fetch follows.
      const response = await githubFetch(context.access, `${repoPath(context.repo)}/actions/jobs/${job.id}/logs`, {
        timeoutMs: 120_000,
      }).catch(() => undefined)
      const tail = response ? await readTail(response, MAX_LOG_BYTES).catch(() => undefined) : undefined
      return tail ? { lines: failedStepLog(tail.text, job), truncated: tail.truncated } : undefined
    }),
  )
  const parsed = parseFailureLog(logs.flatMap((log) => log?.lines ?? []).join("\n"))
  const steps = parsed.length ? parsed : failedStepsFromJobs(jobs.jobs)
  return {
    ok: true,
    failure: {
      repo: `${context.repo.owner}/${context.repo.name}`,
      run: toRun(raw),
      steps: steps.slice(0, MAX_STEPS),
      logTruncated: logs.some((log) => log?.truncated),
    },
  }
}

// A job's log runs every step together. The step that failed is the one whose
// "##[group]Run" header comes last before the job's final "##[error]", the same
// slice `gh run view --log-failed` shows, prefixed "<job>\t<step>\t" the way
// parseFailureLog reads it.
export function failedStepLog(log: string, job: RawJob) {
  const lines = log.split(/\r?\n/)
  const exitLine = lines.findLastIndex((line) =>
    /^##\[error\]Process completed with exit code/.test(cleanLogLine(line)),
  )
  const errorLine = exitLine >= 0 ? exitLine : lines.findLastIndex((line) => /^##\[error\]/.test(cleanLogLine(line)))
  const end = errorLine >= 0 ? errorLine + 1 : lines.length
  const start = Math.max(
    0,
    lines.slice(0, end).findLastIndex((line) => /^##\[group\]Run\s/.test(cleanLogLine(line))),
  )
  const step = (job.steps ?? []).find((candidate) => candidate.conclusion === "failure")?.name ?? ""
  const name = (job.name ?? "").replaceAll("\t", " ")
  return lines
    .slice(start, end)
    .filter((line) => line.trim() !== "")
    .map((line) => `${name}\t${step.replaceAll("\t", " ")}\t${line}`)
}

export async function prepareCiRepair(
  projectPath: string,
  runId: number,
): Promise<{ ok: true; failure: CiFailure; prompt: string } | CiUnavailable> {
  const result = await viewCiFailure(projectPath, runId)
  if (!result.ok) return result
  return { ok: true, failure: result.failure, prompt: buildRepairPrompt(result.failure) }
}

// Polling is deliberate: Actions has no push channel a desktop app can hold
// open, and a run triggered by a push takes minutes to go red anyway. A run id
// only fires once, so a failure the user has already seen does not re-announce
// itself on every tick.
export function watchCi(input: { projectPath: string; intervalMs?: number; onFailure: (failure: CiFailure) => void }) {
  const seen = new Set<number>()
  let stopped = false
  let polling = false
  const poll = async () => {
    if (polling || stopped) return
    polling = true
    const runs = await listCiRuns(input.projectPath, { limit: 10 })
    const failing =
      runs.ok &&
      runs.runs.find(
        (candidate) =>
          candidate.status === "completed" && FAILED_CONCLUSIONS.has(candidate.conclusion) && !seen.has(candidate.id),
      )
    const failure = failing ? await viewCiFailure(input.projectPath, failing.id) : undefined
    polling = false
    if (stopped || !failing || !failure?.ok) return
    seen.add(failing.id)
    input.onFailure(failure.failure)
  }
  void poll()
  const timer = setInterval(() => void poll(), input.intervalMs ?? 60_000)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

// `gh run view --log-failed` prefixes every line with "<job>\t<step>\t<raw log
// line>", and the raw line still carries the Actions timestamp plus whatever
// ANSI the tool emitted. Kept pure — this is the part with real logic, and it
// degrades to one unnamed step when handed a plain log file.
export function parseFailureLog(log: string, options?: { maxExcerptBytes?: number }): CiFailedStep[] {
  const maxExcerptBytes = options?.maxExcerptBytes ?? MAX_EXCERPT_BYTES
  const groups = new Map<string, { job: string; step: string; lines: string[] }>()
  for (const raw of log.split(/\r?\n/)) {
    const columns = raw.split("\t")
    const prefixed = columns.length >= 3
    const job = prefixed ? columns[0].trim() : ""
    const step = prefixed ? columns[1].trim() : ""
    const key = `${job}\u0000${step}`
    const group = groups.get(key) ?? { job, step, lines: [] }
    group.lines.push(cleanLogLine(prefixed ? columns.slice(2).join("\t") : raw))
    groups.set(key, group)
  }
  return Array.from(groups.values())
    .map((group): CiFailedStep => {
      const signals = group.lines.flatMap((line, index) => {
        const signal = SIGNALS.find((candidate) => candidate.pattern.test(line))
        return signal ? [{ index, kind: signal.kind }] : []
      })
      const kind = KIND_PRIORITY.find((candidate) => signals.some((signal) => signal.kind === candidate)) ?? "unknown"
      const anchor = signals.find((signal) => signal.kind === kind)?.index
      const window = group.lines.slice(anchor === undefined ? 0 : Math.max(0, anchor - CONTEXT_LINES))
      const first = window.findIndex((line) => line.trim() !== "")
      const body = first < 0 ? [] : window.slice(first, window.findLastIndex((line) => line.trim() !== "") + 1)
      // Redaction runs last, on the clamped window rather than the whole log, so
      // the expensive pass only ever sees a few KB. It can still make a line
      // LONGER ("password: b" -> "password: [REDACTED]"), so re-clamp when it
      // pushes the result back over the cap; otherwise maxExcerptBytes is a
      // budget on raw bytes rather than on what actually leaves this function.
      const excerpt = redactText(clampExcerpt(body, maxExcerptBytes))
      return {
        job: group.job,
        step: group.step,
        kind,
        command: extractCommand(group.lines),
        exitCode: group.lines
          .flatMap((line) => line.match(EXIT_CODE)?.[1] ?? [])
          .map((code) => Number(code))
          .at(-1),
        excerpt:
          Buffer.byteLength(excerpt) <= maxExcerptBytes ? excerpt : clampExcerpt(excerpt.split("\n"), maxExcerptBytes),
      }
    })
    .filter((step) => step.excerpt || step.command || step.exitCode !== undefined)
}

// The agent gets one message and no chat history, so it carries the whole story:
// which workflow went red, the command that produced it, the trimmed log, and an
// order to reproduce before touching anything.
export function buildRepairPrompt(failure: CiFailure) {
  return [
    `The GitHub Actions workflow "${failure.run.workflow}" failed on branch ${failure.run.branch}.`,
    `Repository: ${failure.repo}`,
    `Run: ${failure.run.url} (run #${failure.run.number}${failure.run.headSha ? `, commit ${failure.run.headSha.slice(0, 7)}` : ""})`,
    ...(failure.logTruncated ? ["NOTE: the CI log was too large to read in full; only the tail was kept."] : []),
    "",
    ...failure.steps.flatMap((step) => [
      `--- Failed step: ${step.job || "unknown job"} > ${step.step || "unknown step"} (${step.kind}${
        step.exitCode === undefined ? "" : `, exit code ${step.exitCode}`
      })`,
      step.command ? `Command:\n${step.command}` : "Command: the log did not record one.",
      step.excerpt
        ? `Log excerpt (trimmed, secrets redacted):\n\`\`\`\n${step.excerpt}\n\`\`\``
        : "Log excerpt: GitHub returned no log for this step.",
      "",
    ]),
    "Fix this failure:",
    "1. FIRST reproduce it locally by running the exact command above in this repository. Do not edit any file until you have seen the same failure on this machine.",
    "2. If the command passes locally, say so and work out what differs in CI — runner OS, tool version, environment variables, a cold cache — before changing code.",
    "3. Make the smallest change that fixes the actual cause. Never delete, skip, or weaken a test to make CI green.",
    "4. Re-run the same command locally to confirm it passes, then summarise what was broken.",
  ].join("\n")
}

export async function detectCiRepo(projectPath: string): Promise<{ ok: true; repo: CiRepo } | CiUnavailable> {
  const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath })
  if (inside.failed || !/true/.test(inside.stdout)) {
    return {
      ok: false,
      reason: "not-a-repo",
      detail: "This project is not a git repository, so it has no CI runs.",
      command: "git init",
    }
  }
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: projectPath })
  const remote = origin.stdout.trim()
  if (origin.failed || !remote) {
    return {
      ok: false,
      reason: "no-remote",
      detail: "This project has no `origin` remote, so there is nowhere to read workflow runs from.",
      command: "git remote add origin https://github.com/<owner>/<repo>.git",
    }
  }
  const slug = parseGithubRemote(remote)
  if (!slug) {
    return {
      ok: false,
      reason: "no-remote",
      detail: `\`origin\` points at ${remote}, which is not GitHub. Vector reads CI from GitHub Actions.`,
      command: "git remote set-url origin https://github.com/<owner>/<repo>.git",
    }
  }
  const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectPath })
  const branch = head.stdout.trim()
  if (head.failed || !branch || branch === "HEAD") {
    return {
      ok: false,
      reason: "no-branch",
      detail: "HEAD is detached, so there is no branch to match workflow runs against.",
      command: "git switch -c <branch>",
    }
  }
  return { ok: true, repo: { owner: slug.owner, name: slug.name, branch, remote } }
}

type RunResult = { stdout: string; stderr: string; failed: boolean }

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<RunResult>((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        env: untrustedChildEnvironment(),
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) }),
    )
  })
}

// GitHub's REST shape of a workflow run and a job.
type RawRun = {
  id?: number
  run_number?: number
  name?: string | null
  display_title?: string
  head_branch?: string | null
  head_sha?: string
  event?: string
  status?: string | null
  conclusion?: string | null
  html_url?: string
  created_at?: string
}

type RawJob = {
  id?: number
  name?: string
  conclusion?: string | null
  steps?: { name?: string; conclusion?: string | null }[]
}

function toRun(raw: RawRun): CiRun {
  return {
    id: raw.id ?? 0,
    number: raw.run_number ?? 0,
    workflow: raw.name ?? "workflow",
    title: raw.display_title ?? "",
    branch: raw.head_branch ?? "",
    headSha: raw.head_sha ?? "",
    event: raw.event ?? "",
    status: raw.status ?? "",
    conclusion: raw.conclusion ?? "",
    url: raw.html_url ?? "",
    createdAt: raw.created_at ?? "",
  }
}

function failed(error: unknown, fallback: string): CiUnavailable {
  const message = error instanceof Error && error.message ? error.message : fallback
  return { ok: false, reason: "github-failed", detail: message, command: "" }
}

function repoPath(repo: CiRepo) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function failedStepsFromJobs(jobs: RawJob[] | undefined): CiFailedStep[] {
  return (jobs ?? [])
    .filter((job) => job.conclusion === "failure")
    .flatMap((job) =>
      (job.steps ?? [])
        .filter((step) => step.conclusion === "failure")
        .map((step) => ({ job: job.name ?? "", step: step.name ?? "", kind: "unknown" as const, excerpt: "" })),
    )
}

const ANSI = /\u001B\[[0-?]*[ -\/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/
const EXIT_CODE = /Process completed with exit code (\d+)/

// One raw Actions log line without its ANSI colouring or leading timestamp.
export function cleanLogLine(line: string) {
  return line.replace(ANSI, "").replace(TIMESTAMP, "")
}

// Ordered by how much each one narrows the problem down: a type error names the
// exact file and column, a test summary names the case, a lint block names the
// rule, and "exit code 1" only says that something died.
const KIND_PRIORITY = ["type-error", "test-failure", "lint", "exit-code"] as const

const SIGNALS = [
  { kind: "type-error", pattern: /\berror TS\d+\b/ },
  { kind: "type-error", pattern: /^\s*Found \d+ errors? in\b/ },
  { kind: "test-failure", pattern: /^\s*\(fail\)\s/ },
  { kind: "test-failure", pattern: /^\s*\d+ fail\b/ },
  { kind: "test-failure", pattern: /^\s*FAIL\s+\S/ },
  { kind: "test-failure", pattern: /^\s*Tests\s+\d+ failed/ },
  { kind: "test-failure", pattern: /^\s*●\s+\S/ },
  { kind: "test-failure", pattern: /^\s*Tests:\s+\d+ failed/ },
  { kind: "test-failure", pattern: /^\s*FAILED\s+\S+::/ },
  { kind: "test-failure", pattern: /^=+ \d+ failed/ },
  { kind: "test-failure", pattern: /^\s*--- FAIL: \S/ },
  { kind: "lint", pattern: /^\s*✖\s+\d+ problems?\b/ },
  { kind: "lint", pattern: /^\s*\d+:\d+\s+error\s+\S/ },
  { kind: "lint", pattern: /^\s*[×x]\s+[\w@/-]+\([\w/-]+\)/ },
  { kind: "lint", pattern: /^\s*Found \d+ warnings? and \d+ errors?\b/ },
  { kind: "exit-code", pattern: EXIT_CODE },
  { kind: "exit-code", pattern: /^##\[error\]/ },
] as const

function extractCommand(lines: string[]) {
  const start = lines.findIndex((line) => /^##\[group\]Run\s/.test(line))
  if (start < 0) return undefined
  // The group header only carries the first line of a multi-line `run:` script,
  // but Actions echoes the whole script underneath it before printing the shell
  // and env it used. Take that echo, and fall back to the header for `uses:`
  // steps, which have no script to echo.
  const body = lines.slice(start + 1)
  const end = body.findIndex((line) => /^\s*(shell|env|with):/.test(line) || /^##\[endgroup\]/.test(line))
  const command =
    (end < 0 ? body : body.slice(0, end)).join("\n").trim() || lines[start].replace(/^##\[group\]Run\s+/, "").trim()
  // The echoed script is log text like any other: a workflow that hardcodes a
  // token in its `run:` block would otherwise hand it straight to the model,
  // under a prompt that promises the payload is redacted.
  return command ? redactText(command) : undefined
}

function clampExcerpt(lines: string[], maxBytes: number) {
  const size = (line: string) => Buffer.byteLength(line) + 1
  if (lines.reduce((total, line) => total + size(line), 0) <= maxBytes) return lines.join("\n")
  // Keep both ends. The head names what broke first and the tail carries the
  // runner's summary count; the middle is nearly always the same failure again.
  const budget = Math.max(0, maxBytes - TRIM_MARKER_BYTES)
  const head: string[] = []
  let headBytes = 0
  for (const line of lines) {
    if (headBytes + size(line) > budget * 0.6) break
    head.push(line)
    headBytes += size(line)
  }
  const tail: string[] = []
  let tailBytes = 0
  for (const line of lines.slice(head.length).toReversed()) {
    if (tailBytes + size(line) > budget - headBytes) break
    tail.unshift(line)
    tailBytes += size(line)
  }
  return [...head, `… ${lines.length - head.length - tail.length} log lines trimmed …`, ...tail].join("\n")
}
