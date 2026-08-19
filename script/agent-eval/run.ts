#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { aggregate, scoreTask, type FileDiff, type RuntimeId, type TaskRun, type TaskScore } from "./score"
import { TASKS, scoringSpec, taskById, type EvalTask } from "./tasks"

// Runner for the agent eval harness. Builds each fixture in a throwaway
// directory, drives one of the four runtimes Vector hosts against it headlessly,
// runs the task's own objective check, and scores the result with score.ts.
//
// The one rule this file must never break: a runtime that is missing or not
// signed in is reported as "unavailable" and left out of the aggregates. A zero
// there would read as "the agent failed every task", which is a different and
// much more alarming claim than "we could not measure it".

const REPO_ROOT = join(import.meta.dir, "..", "..")
const CHECK_TIMEOUT_MS = 120_000
const GIT_TIMEOUT_MS = 60_000
const OUTPUT_TAIL_CHARS = 4_000

const RUNTIME_CLI: Record<RuntimeId, string> = {
  vector: "vector",
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor-agent",
}

const RUNTIME_NAME: Record<RuntimeId, string> = {
  vector: "Vector",
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor Agent",
}

// A non-zero exit that also produced no edits is usually a login, provider, or
// model-selection problem rather than a failed attempt, and scoring those as a
// zero would read as "the agent failed the task" when nothing about the agent
// was ever measured. Matching any of these downgrades such a run to
// "unavailable". The heuristic is one-directional and gated on a non-zero exit
// with an empty diff, so it can never turn a real attempt into a non-result.
//
// The provider entries are not hypothetical: the first live run of this harness
// against Vector's own engine died on "The model `whisper-large-v3-turbo` does
// not support chat completions", which the earlier auth-only list scored as a 0.
const RUNTIME_UNUSABLE_PATTERNS = [
  /not (?:logged in|authenticated|signed in)/i,
  /please (?:log ?in|sign ?in)/i,
  /auth(?:entication)? (?:is )?(?:required|failed|error)/i,
  /(?:invalid|missing|no) api key/i,
  /unauthorized/i,
  /credit balance is too low/i,
  /oauth token (?:has )?expired/i,
  /no providers? (?:are )?(?:configured|available)/i,
  /run .{0,24}auth login/i,
  /subscription (?:is )?required/i,
  /does not support chat completions/i,
  /model .{0,80}(?:not found|does not exist|is not available|is not supported)/i,
  /no model (?:is )?(?:configured|selected|available)/i,
  /invalid_request_error/i,
  /rate.?limit/i,
  /(?:quota|credits?) (?:exceeded|exhausted)/i,
  /insufficient (?:quota|credit|balance|funds)/i,
  /overloaded/i,
]

const USAGE = `Usage: bun script/agent-eval/run.ts [options]

  --runtime <id>      One of: vector, claude-code, codex, cursor
  --compare <ids>     Comma-separated runtimes to run and print side by side
  --tasks <spec>      "all" (default) or a comma-separated list of task ids
  --model <id>        Model passed through to the runtime's own --model flag
  --out <path>        Where to write the JSON report
  --timeout <sec>     Per-task agent timeout, overriding the task's own
  --keep              Keep the fixture directories after the run
  --list              Print the task set and exit
  --help              Print this message
`

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (flags.list) {
    process.stdout.write(
      formatTable([["ID", "CATEGORY", "TITLE"], ...TASKS.map((task) => [task.id, task.category, task.title])]) + "\n",
    )
    return 0
  }

  const runtimes = resolveRuntimes(flags)
  if (typeof runtimes === "string") {
    process.stderr.write(`${runtimes}\n\n${USAGE}`)
    return 2
  }
  const tasks = resolveTasks(flags.tasks)
  if (typeof tasks === "string") {
    process.stderr.write(`${tasks}\n\n${USAGE}`)
    return 2
  }

  const root = await mkdtemp(join(tmpdir(), "vector-agent-eval-"))
  const startedAt = new Date().toISOString()
  process.stderr.write(`Fixtures: ${root}\n`)

  const results: RuntimeReport[] = []
  for (const runtime of runtimes) {
    const launcher = await resolveLauncher(runtime)
    process.stderr.write(`\n=== ${RUNTIME_NAME[runtime]} — ${launcher ? launcher.label : "not installed"} ===\n`)
    const reports: TaskReport[] = []
    for (const task of tasks) {
      reports.push(await runTask({ runtime, launcher, task, root, model: flags.model, timeout: flags.timeout }))
    }
    results.push({
      runtime,
      launcher: launcher?.label,
      aggregate: aggregate(
        runtime,
        reports.map((report) => report.score),
      ),
      tasks: reports,
    })
  }

  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    model: flags.model,
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    fixtureRoot: root,
    runtimes: results,
  }
  const out = flags.out ?? join(tmpdir(), `vector-agent-eval-${Date.now()}.json`)
  await writeFile(out, JSON.stringify(report, null, 2) + "\n")

  process.stdout.write("\n" + renderReport(results) + "\n")
  process.stdout.write(`\nJSON report: ${out}\n`)
  if (flags.keep) process.stdout.write(`Fixtures kept: ${root}\n`)
  if (!flags.keep) await rm(root, { recursive: true, force: true })

  // Exit non-zero only when something actually failed a measurement. An
  // unavailable runtime is not a failure of this harness or of the agent.
  return results.some((entry) => entry.aggregate.failed > 0 || entry.aggregate.errored > 0) ? 1 : 0
}

type Launcher = { command: string; prefix: string[]; label: string }

type TaskReport = {
  run: TaskRun
  score: TaskScore
  agentOutputTail: string
  checkOutputTail: string
}

type RuntimeReport = {
  runtime: RuntimeId
  launcher?: string
  aggregate: ReturnType<typeof aggregate>
  tasks: TaskReport[]
}

async function runTask(input: {
  runtime: RuntimeId
  launcher: Launcher | undefined
  task: EvalTask
  root: string
  model?: string
  timeout?: number
}): Promise<TaskReport> {
  const spec = scoringSpec(input.task)
  const label = `${input.runtime}/${input.task.id}`
  if (!input.launcher) {
    const detail = `${RUNTIME_NAME[input.runtime]} CLI (${RUNTIME_CLI[input.runtime]}) was not found on PATH.`
    process.stderr.write(`  ${label}: unavailable — ${detail}\n`)
    const run: TaskRun = { taskId: input.task.id, runtime: input.runtime, status: "unavailable", detail }
    return { run, score: scoreTask(spec, run), agentOutputTail: "", checkOutputTail: "" }
  }

  const dir = join(input.root, input.runtime, input.task.id)
  const fixture = await createFixture(input.task, dir)
  if ("error" in fixture) {
    process.stderr.write(`  ${label}: harness error — ${fixture.error}\n`)
    const run: TaskRun = {
      taskId: input.task.id,
      runtime: input.runtime,
      status: "harness-error",
      detail: fixture.error,
    }
    return { run, score: scoreTask(spec, run), agentOutputTail: "", checkOutputTail: "" }
  }

  process.stderr.write(`  ${label}: running…\n`)
  const timeoutMs = input.timeout ? input.timeout * 1000 : input.task.timeoutMs
  const started = Date.now()
  const agent = await capture({
    command: input.launcher.command,
    args: [...input.launcher.prefix, ...agentArguments(input.runtime, dir, input.task.prompt, input.model)],
    cwd: dir,
    timeoutMs,
  })
  const wallMs = Date.now() - started

  const collected = await collectDiff(dir, fixture.baseline)
  if ("error" in collected) {
    const run: TaskRun = {
      taskId: input.task.id,
      runtime: input.runtime,
      status: "harness-error",
      detail: collected.error,
    }
    return { run, score: scoreTask(spec, run), agentOutputTail: tail(agent.output), checkOutputTail: "" }
  }
  const diff = collected.diff

  const unusable = agent.exitCode !== 0 && diff.length === 0 ? unusableReason(agent.output) : undefined
  if (unusable) {
    const detail = `${RUNTIME_NAME[input.runtime]} exited ${agent.exitCode} with no edits: ${unusable}`
    process.stderr.write(`  ${label}: unavailable — ${detail}\n`)
    const run: TaskRun = { taskId: input.task.id, runtime: input.runtime, status: "unavailable", detail }
    return { run, score: scoreTask(spec, run), agentOutputTail: tail(agent.output), checkOutputTail: "" }
  }
  if (agent.timedOut) process.stderr.write(`  ${label}: agent hit the ${timeoutMs / 1000}s timeout\n`)

  const check = await capture({
    command: input.task.check.command,
    args: input.task.check.args,
    cwd: dir,
    timeoutMs: CHECK_TIMEOUT_MS,
  })
  const protectedViolations = await findProtectedViolations(input.task, dir)
  const assertionFailures = await findAssertionFailures(input.task, dir)
  const mutationsCaught =
    check.exitCode === 0 && protectedViolations.length === 0 && assertionFailures.length === 0
      ? await countMutationsCaught(input.task, dir)
      : 0

  const run: TaskRun = {
    taskId: input.task.id,
    runtime: input.runtime,
    status: "ran",
    wallMs,
    agentExitCode: agent.exitCode,
    checkExitCode: check.exitCode,
    diff,
    protectedViolations,
    assertionFailures,
    mutationsCaught,
    costUsd: agent.meter.cost,
    tokens: agent.meter.tokens,
  }
  const score = scoreTask(spec, run)
  process.stderr.write(
    `  ${label}: ${score.outcome} score=${score.score} files=${score.filesTouched} out-of-scope=${score.outOfScopeFiles.length} ${(wallMs / 1000).toFixed(1)}s\n`,
  )
  return { run, score, agentOutputTail: tail(agent.output), checkOutputTail: tail(check.output) }
}

// Mirrors packages/desktop/src/main/external-agents.ts runtimeArguments. It is
// duplicated rather than imported because that module imports electron at the
// top level, which a plain bun script cannot load.
function agentArguments(runtime: RuntimeId, cwd: string, prompt: string, model?: string) {
  if (runtime === "vector") {
    return ["run", "--format", "json", "--auto", ...(model ? ["--model", model] : []), prompt]
  }
  if (runtime === "claude-code") {
    return [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      ...(model ? ["--model", model] : []),
    ]
  }
  if (runtime === "codex") {
    return [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      cwd,
      ...(model ? ["--model", model] : []),
      prompt,
    ]
  }
  return ["-p", "--force", "--output-format", "stream-json", ...(model ? ["--model", model] : []), prompt]
}

async function resolveLauncher(runtime: RuntimeId): Promise<Launcher | undefined> {
  if (runtime !== "vector") {
    const binary = await resolveBinary(RUNTIME_CLI[runtime])
    if (!binary) return undefined
    return { command: binary, prefix: [], label: binary }
  }
  // Vector's engine is usually not on PATH during development, so fall back to
  // running it straight from source the way packages/opencode's own CLI tests do.
  const explicit = process.env.VECTOR_EVAL_ENGINE
  const binary = explicit ?? (await resolveBinary("vector")) ?? (await resolveBinary("opencode"))
  if (binary) return { command: binary, prefix: [], label: binary }
  const source = join(REPO_ROOT, "packages", "opencode", "src", "index.ts")
  if (!(await exists(source))) return undefined
  return { command: "bun", prefix: ["run", "--conditions=browser", source], label: `bun run ${source}` }
}

async function resolveBinary(cli: string) {
  const lookup = await capture({
    command: process.platform === "win32" ? "where" : "which",
    args: [cli],
    cwd: process.cwd(),
    timeoutMs: 5_000,
  })
  const found = lookup.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (lookup.exitCode === 0 && found) return found
  const suffix = process.platform === "win32" ? ".exe" : ""
  const candidates = [
    join(homedir(), ".local", "bin", `${cli}${suffix}`),
    `/opt/homebrew/bin/${cli}`,
    `/usr/local/bin/${cli}`,
    ...(cli === "codex" ? ["/Applications/ChatGPT.app/Contents/Resources/codex"] : []),
  ]
  const hits = await Promise.all(candidates.map(async (path) => ((await exists(path)) ? path : undefined)))
  return hits.find((path): path is string => Boolean(path))
}

async function createFixture(task: EvalTask, dir: string): Promise<{ baseline: string } | { error: string }> {
  await mkdir(dir, { recursive: true })
  await Promise.all(
    Object.entries(task.files).map(async ([path, content]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }),
  )
  // A git baseline is what makes diff surface measurable no matter how the
  // agent edits, and it keeps working when the agent decides to commit.
  const identity = ["-c", "user.name=Vector Eval", "-c", "user.email=eval@vector.local", "-c", "commit.gpgsign=false"]
  const init = await git(dir, ["-c", "init.defaultBranch=eval", "init", "--quiet"])
  if (init.exitCode !== 0) return { error: `git init failed: ${init.output.trim() || "git is not installed"}` }
  const add = await git(dir, [...identity, "add", "-A"])
  if (add.exitCode !== 0) return { error: `git add failed: ${add.output.trim()}` }
  const commit = await git(dir, [...identity, "commit", "--quiet", "-m", "baseline"])
  if (commit.exitCode !== 0) return { error: `git commit failed: ${commit.output.trim()}` }
  const head = await git(dir, ["rev-parse", "HEAD"])
  if (head.exitCode !== 0) return { error: `git rev-parse failed: ${head.output.trim()}` }
  return { baseline: head.output.trim() }
}

async function collectDiff(dir: string, baseline: string): Promise<{ diff: FileDiff[] } | { error: string }> {
  const staged = await git(dir, ["-c", "user.name=Vector Eval", "-c", "user.email=eval@vector.local", "add", "-A"])
  if (staged.exitCode !== 0) return { error: `git add failed after the run: ${staged.output.trim()}` }
  const diff = await git(dir, ["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", "--cached", baseline])
  if (diff.exitCode !== 0) return { error: `git diff failed: ${diff.output.trim()}` }
  return {
    diff: diff.output
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length >= 3 && Boolean(parts[2]))
      .map((parts) => ({
        path: parts.slice(2).join("\t"),
        added: Number(parts[0]) || 0,
        removed: Number(parts[1]) || 0,
      })),
  }
}

async function findProtectedViolations(task: EvalTask, dir: string) {
  const checked = await Promise.all(
    task.protectedFiles.map(async (path) => {
      const current = await readFile(join(dir, path), "utf8").catch(() => undefined)
      return current === task.files[path] ? undefined : path
    }),
  )
  return checked.filter((path): path is string => Boolean(path))
}

async function findAssertionFailures(task: EvalTask, dir: string) {
  const checked = await Promise.all(
    task.assertions.map(async (assertion) => {
      const content = await readFile(join(dir, assertion.path), "utf8").catch(() => undefined)
      if (content === undefined) return assertion.exists === false ? undefined : `${assertion.path} is missing`
      if (assertion.exists === false) return `${assertion.path} should not exist`
      const missing = (assertion.includes ?? []).filter((needle) => !content.includes(needle))
      const lingering = (assertion.excludes ?? []).filter((needle) => content.includes(needle))
      if (missing.length === 0 && lingering.length === 0) return undefined
      return [
        missing.length > 0 ? `${assertion.path} does not contain ${missing.join(", ")}` : undefined,
        lingering.length > 0 ? `${assertion.path} still contains ${lingering.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join("; ")
    }),
  )
  return checked.filter((entry): entry is string => Boolean(entry))
}

// Seeded-defect coverage: break the implementation one way at a time and
// require the suite the agent wrote to notice. Runs strictly sequentially
// because every mutation edits and restores the same file.
function countMutationsCaught(task: EvalTask, dir: string) {
  return task.mutations.reduce(async (previous, mutation) => {
    const caught = await previous
    const path = join(dir, mutation.path)
    const original = await readFile(path, "utf8").catch(() => undefined)
    if (original === undefined || !original.includes(mutation.find)) return caught
    await writeFile(path, original.replace(mutation.find, mutation.replace))
    const result = await capture({
      command: task.check.command,
      args: task.check.args,
      cwd: dir,
      timeoutMs: CHECK_TIMEOUT_MS,
    })
    await writeFile(path, original)
    return caught + (result.exitCode === 0 ? 0 : 1)
  }, Promise.resolve(0))
}

type Meter = { cost?: number; tokens?: number }

type CaptureResult = { exitCode: number; output: string; meter: Meter; timedOut: boolean }

function capture(input: { command: string; args: string[]; cwd: string; timeoutMs: number }) {
  return new Promise<CaptureResult>((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      // "ignore" rather than a pipe: several of these CLIs read a non-TTY stdin
      // as their prompt and would block forever on an open, empty pipe.
      stdio: ["ignore", "pipe", "pipe"],
    })
    const lines: string[] = []
    let meter: Meter = {}
    let settled = false
    let timedOut = false

    const consume = (chunk: Buffer) => {
      chunk
        .toString("utf8")
        .split(/\r?\n/)
        .forEach((line) => {
          if (!line.trim()) return
          lines.push(line)
          if (lines.length > 4_000) lines.shift()
          meter = applyMeter(meter, line)
        })
    }
    child.stdout.on("data", consume)
    child.stderr.on("data", consume)

    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === "win32" || !child.pid) {
        child.kill("SIGKILL")
        return
      }
      // These CLIs spawn their own tool subprocesses; killing the group is the
      // only way a timeout does not leave a shell or a test runner behind.
      process.kill(-child.pid, "SIGKILL")
    }, input.timeoutMs)

    const finish = (exitCode: number, extra?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode,
        output: [...lines, ...(extra ? [extra] : [])].join("\n"),
        meter,
        timedOut,
      })
    }
    child.once("error", (error) => finish(127, error.message))
    child.once("close", (code) => finish(timedOut ? 124 : (code ?? 1)))
  })
}

function applyMeter(meter: Meter, line: string): Meter {
  if (!line.startsWith("{")) return meter
  const event = parseJsonLine(line)
  if (!event) return meter
  // Vector emits one step_finish per provider turn carrying that turn's cost
  // and tokens, so these accumulate across the run.
  if (event.type === "step_finish") {
    const part = asRecord(event.part)
    const tokens = asRecord(part?.tokens)
    const input = numberOrZero(tokens?.input) + numberOrZero(tokens?.output)
    return {
      cost: (meter.cost ?? 0) + numberOrZero(part?.cost),
      tokens: (meter.tokens ?? 0) + input,
    }
  }
  // claude-code and cursor emit a single terminal result carrying the run
  // total, and codex reports a cumulative usage object; last value wins.
  const usage = asRecord(event.usage) ?? asRecord(asRecord(event.info)?.total_token_usage)
  const total =
    numberOrUndefined(event.total_cost_usd) ?? numberOrUndefined(event.cost_usd) ?? numberOrUndefined(event.cost)
  const totalTokens =
    numberOrUndefined(usage?.total_tokens) ??
    (usage ? numberOrZero(usage.input_tokens) + numberOrZero(usage.output_tokens) || undefined : undefined)
  return {
    cost: total ?? meter.cost,
    tokens: totalTokens ?? meter.tokens,
  }
}

// Mirrors the defensive line parsing in external-agents.ts: agent stdout is a
// mixed stream and a malformed line must never take the run down.
function parseJsonLine(line: string) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberOrZero(value: unknown) {
  return numberOrUndefined(value) ?? 0
}

// Quote the offending text rather than asserting "authentication problem", so a
// reader of the report can tell a real login prompt from a pattern that matched
// something harmless, and correct the harness if it got it wrong.
function unusableReason(output: string) {
  const hit = output
    .split(/\r?\n/)
    .flatMap((line) => RUNTIME_UNUSABLE_PATTERNS.map((pattern) => line.match(pattern)))
    .find((match): match is RegExpMatchArray => Boolean(match))
  if (!hit?.input) return undefined
  const at = hit.index ?? 0
  const window = hit.input.slice(Math.max(0, at - 60), at + 160).trim()
  return window.length < hit.input.length ? `…${window}…` : window
}

function git(dir: string, args: string[]) {
  return capture({ command: "git", args, cwd: dir, timeoutMs: GIT_TIMEOUT_MS })
}

function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

function tail(output: string) {
  return output.length > OUTPUT_TAIL_CHARS ? `…\n${output.slice(-OUTPUT_TAIL_CHARS)}` : output
}

function parseFlags(argv: string[]) {
  const raw = argv.reduce<Record<string, string>>((flags, token, index) => {
    if (!token.startsWith("--")) return flags
    const equals = token.indexOf("=")
    if (equals !== -1) return { ...flags, [token.slice(2, equals)]: token.slice(equals + 1) }
    const next = argv[index + 1]
    return { ...flags, [token.slice(2)]: next && !next.startsWith("--") ? next : "true" }
  }, {})
  return {
    help: raw.help === "true",
    list: raw.list === "true",
    keep: raw.keep === "true",
    runtime: raw.runtime,
    compare: raw.compare,
    tasks: raw.tasks,
    model: raw.model,
    out: raw.out,
    timeout: raw.timeout ? Number(raw.timeout) : undefined,
  }
}

function resolveRuntimes(flags: ReturnType<typeof parseFlags>) {
  const isRuntimeId = (value: string): value is RuntimeId => value in RUNTIME_CLI
  const requested = (flags.compare ?? flags.runtime ?? "vector").split(",").map((entry) => entry.trim())
  const unknown = requested.filter((entry) => !isRuntimeId(entry))
  if (unknown.length > 0) return `Unknown runtime(s): ${unknown.join(", ")}`
  return requested.filter(isRuntimeId)
}

function resolveTasks(spec: string | undefined) {
  if (!spec || spec === "all") return TASKS
  const requested = spec.split(",").map((entry) => entry.trim())
  const resolved = requested.map((id) => taskById(id))
  const missing = requested.filter((id, index) => !resolved[index])
  if (missing.length > 0) return `Unknown task id(s): ${missing.join(", ")}. Run with --list to see the task set.`
  return resolved.filter((task): task is EvalTask => Boolean(task))
}

function renderReport(results: RuntimeReport[]) {
  const perRuntime = results.map((entry) => {
    const rows = [
      ["TASK", "CATEGORY", "OUTCOME", "SCORE", "FILES", "OUT", "MUT", "WALL", "COST"],
      ...entry.tasks.map((report) => {
        const measured = report.score.outcome === "pass" || report.score.outcome === "fail"
        const seeded = taskById(report.score.taskId)?.mutations.length ?? 0
        return [
          report.score.taskId,
          report.score.category,
          report.score.outcome,
          measured ? String(report.score.score) : "—",
          measured ? String(report.score.filesTouched) : "—",
          measured ? String(report.score.outOfScopeFiles.length) : "—",
          report.run.status === "ran" && seeded > 0 ? `${report.run.mutationsCaught}/${seeded}` : "—",
          report.score.wallMs === undefined ? "—" : `${(report.score.wallMs / 1000).toFixed(1)}s`,
          report.score.costUsd === undefined ? "—" : `$${report.score.costUsd.toFixed(4)}`,
        ]
      }),
    ]
    const summary = entry.aggregate
    const headline =
      summary.measured === 0
        ? `no tasks measured (${summary.unavailable} unavailable, ${summary.errored} harness errors)`
        : `${summary.passed}/${summary.measured} passed · mean score ${summary.meanScore} · ${summary.unavailable} unavailable · ${summary.errored} harness errors`
    const notes = entry.tasks
      .filter((report) => report.score.outcome !== "pass")
      .map((report) => `    ${report.score.taskId}: ${explain(report)}`)
    return [
      `${RUNTIME_NAME[entry.runtime]} (${entry.launcher ?? "not installed"})`,
      formatTable(rows)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
      `  ${headline}`,
      ...(notes.length > 0 ? ["  Not passing:", ...notes] : []),
    ].join("\n")
  })
  if (results.length < 2) return perRuntime.join("\n\n")

  const comparison = formatTable([
    ["TASK", ...results.map((entry) => RUNTIME_NAME[entry.runtime])],
    ...TASKS.filter((task) =>
      results.some((entry) => entry.tasks.some((report) => report.score.taskId === task.id)),
    ).map((task) => [
      task.id,
      ...results.map((entry) => {
        const found = entry.tasks.find((report) => report.score.taskId === task.id)
        if (!found) return "—"
        if (found.score.outcome === "unavailable") return "unavailable"
        if (found.score.outcome === "error") return "harness error"
        return `${found.score.outcome} ${found.score.score}`
      }),
    ]),
  ])
  return [...perRuntime, `Side by side\n${comparison}`].join("\n\n")
}

function explain(report: TaskReport) {
  if (report.run.status !== "ran") return report.run.detail
  if (report.run.protectedViolations.length > 0) {
    return `edited protected file(s): ${report.run.protectedViolations.join(", ")}`
  }
  if (report.run.assertionFailures.length > 0) return report.run.assertionFailures.join("; ")
  if (report.run.checkExitCode !== 0) {
    return `check exited ${report.run.checkExitCode}: ${report.checkOutputTail.split("\n").filter(Boolean).slice(-2).join(" | ")}`
  }
  if (report.score.outOfScopeFiles.length > 0) {
    return `passed but touched ${report.score.outOfScopeFiles.join(", ")}`
  }
  return `passed with a discipline or mutation penalty (score ${report.score.score})`
}

function formatTable(rows: string[][]) {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)))
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

process.exit(await main())
