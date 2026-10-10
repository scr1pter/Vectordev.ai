#!/usr/bin/env bun
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { cacheReadShare, totalTokens } from "./meter"
import { capture } from "./capture"
import { validateTask } from "./validation"
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
  --repeat <count>    Repeat every task 1-20 times (default 1)
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
  if (!Number.isInteger(flags.repeat) || flags.repeat < 1 || flags.repeat > 20) {
    process.stderr.write(`--repeat must be an integer between 1 and 20.\n\n${USAGE}`)
    return 2
  }
  if (flags.timeout !== undefined && (!Number.isFinite(flags.timeout) || flags.timeout <= 0)) {
    process.stderr.write(`--timeout must be a positive finite number.\n\n${USAGE}`)
    return 2
  }

  const root = await mkdtemp(join(tmpdir(), "vector-agent-eval-"))
  const startedAt = new Date().toISOString()
  process.stderr.write(`Fixtures: ${root}\n`)

  const results: RuntimeReport[] = []
  const launchers = new Map<RuntimeId, Launcher | undefined>()
  for (const runtime of runtimes) {
    const launcher = await resolveLauncher(runtime)
    launchers.set(runtime, launcher)
    const version =
      launcher &&
      (await capture({
        command: launcher.command,
        args: [...launcher.prefix, "--version"],
        cwd: REPO_ROOT,
        timeoutMs: 10_000,
      }))
    results.push({
      runtime,
      launcher: launcher?.label,
      version: version?.exitCode === 0 ? version.output.trim() : undefined,
      aggregate: aggregate(runtime, []),
      tasks: [],
    })
  }
  const executionOrder: string[] = []
  for (const [taskIndex, task] of tasks.entries())
    for (const attempt of Array.from({ length: flags.repeat }, (_, index) => index + 1)) {
      const offset = (taskIndex + attempt - 1) % results.length
      for (const entry of [...results.slice(offset), ...results.slice(0, offset)]) {
        executionOrder.push(`${entry.runtime}/${task.id}#${attempt}`)
        entry.tasks.push(
          await runTask({
            runtime: entry.runtime,
            launcher: launchers.get(entry.runtime),
            task,
            root,
            model: flags.model,
            timeout: flags.timeout,
            attempt,
            repetitions: flags.repeat,
          }),
        )
      }
    }
  for (const entry of results)
    entry.aggregate = aggregate(
      entry.runtime,
      entry.tasks.map((report) => report.score),
    )
  const revision = await git(REPO_ROOT, ["rev-parse", "HEAD"])

  const report = {
    schemaVersion: 2,
    mode: "live-public-fixture-smoke-test",
    independentHoldout: false,
    budgetEnforced: false,
    startedAt,
    completedAt: new Date().toISOString(),
    model: flags.model,
    repositoryRevision: revision.exitCode === 0 ? revision.output.trim() : undefined,
    executionOrder,
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    repetitions: flags.repeat,
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
  attempt: number
  run: TaskRun
  score: TaskScore
  agentOutputTail: string
  checkOutputTail: string
}

type RuntimeReport = {
  runtime: RuntimeId
  launcher?: string
  version?: string
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
  attempt: number
  repetitions: number
}): Promise<TaskReport> {
  const spec = scoringSpec(input.task)
  const repetition = input.repetitions > 1 ? `#${input.attempt}/${input.repetitions}` : ""
  const label = `${input.runtime}/${input.task.id}${repetition}`
  if (!input.launcher) {
    const detail = `${RUNTIME_NAME[input.runtime]} CLI (${RUNTIME_CLI[input.runtime]}) was not found on PATH.`
    process.stderr.write(`  ${label}: unavailable — ${detail}\n`)
    const run: TaskRun = { taskId: input.task.id, runtime: input.runtime, status: "unavailable", detail }
    return { attempt: input.attempt, run, score: scoreTask(spec, run), agentOutputTail: "", checkOutputTail: "" }
  }

  const dir = join(input.root, input.runtime, input.task.id, String(input.attempt))
  const fixture = await createFixture(input.task, dir)
  if ("error" in fixture) {
    process.stderr.write(`  ${label}: harness error — ${fixture.error}\n`)
    const run: TaskRun = {
      taskId: input.task.id,
      runtime: input.runtime,
      status: "harness-error",
      detail: fixture.error,
    }
    return { attempt: input.attempt, run, score: scoreTask(spec, run), agentOutputTail: "", checkOutputTail: "" }
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
  const agentCompleted = agent.completed && !agent.runtimeError && !agent.timedOut && agent.exitCode === 0

  const collected = await collectDiff(dir, fixture.baseline)
  if ("error" in collected) {
    const run: TaskRun = {
      taskId: input.task.id,
      runtime: input.runtime,
      status: "harness-error",
      detail: collected.error,
    }
    return {
      attempt: input.attempt,
      run,
      score: scoreTask(spec, run),
      agentOutputTail: tail(agent.output),
      checkOutputTail: "",
    }
  }
  const diff = collected.diff

  const unusable = agent.exitCode !== 0 && diff.length === 0 ? unusableReason(agent.output) : undefined
  if (unusable) {
    const detail = `${RUNTIME_NAME[input.runtime]} exited ${agent.exitCode} with no edits: ${unusable}`
    process.stderr.write(`  ${label}: unavailable — ${detail}\n`)
    const run: TaskRun = { taskId: input.task.id, runtime: input.runtime, status: "unavailable", detail }
    return {
      attempt: input.attempt,
      run,
      score: scoreTask(spec, run),
      agentOutputTail: tail(agent.output),
      checkOutputTail: "",
    }
  }
  if (agent.timedOut) process.stderr.write(`  ${label}: agent hit the ${timeoutMs / 1000}s timeout\n`)

  const check = await validateTask({ task: input.task, agentDir: dir, root: input.root, timeoutMs: CHECK_TIMEOUT_MS })
  if (check.error) {
    const run: TaskRun = { taskId: input.task.id, runtime: input.runtime, status: "harness-error", detail: check.error }
    return {
      attempt: input.attempt,
      run,
      score: scoreTask(spec, run),
      agentOutputTail: tail(agent.output),
      checkOutputTail: tail(check.output),
    }
  }

  const run: TaskRun = {
    taskId: input.task.id,
    runtime: input.runtime,
    status: "ran",
    wallMs,
    validationWallMs: check.wallMs,
    totalWallMs: Date.now() - started,
    agentExitCode: agent.exitCode,
    agentCompleted,
    timedOut: agent.timedOut,
    checkExitCode: check.checkExitCode,
    diff,
    protectedViolations: check.protectedViolations,
    assertionFailures: check.assertionFailures,
    mutationsCaught: check.mutationsCaught,
    costUsd: agent.meter.costUsd,
    knownCostUsd: agent.meter.knownCostUsd,
    costComplete: agent.meter.costComplete !== false && agentCompleted,
    costSource: agent.meter.costSource,
    tokens: agentCompleted ? agent.meter.tokens : undefined,
    requests: agent.meter.requests,
    toolCalls: agent.toolCalls,
  }
  const score = scoreTask(spec, run)
  process.stderr.write(
    `  ${label}: ${score.outcome} score=${score.score} files=${score.filesTouched} out-of-scope=${score.outOfScopeFiles.length} ${(wallMs / 1000).toFixed(1)}s\n`,
  )
  return {
    attempt: input.attempt,
    run,
    score,
    agentOutputTail: tail(agent.output),
    checkOutputTail: tail(check.output),
  }
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
  // running it straight from source the way packages/engine's own CLI tests do.
  const explicit = process.env.VECTOR_EVAL_ENGINE
  const binary = explicit ?? (await resolveBinary("vector"))
  if (binary) return { command: binary, prefix: [], label: binary }
  const source = join(REPO_ROOT, "packages", "engine", "src", "index.ts")
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
    repeat: raw.repeat ? Number(raw.repeat) : 1,
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
      ["TASK", "CATEGORY", "OUTCOME", "SCORE", "FILES", "OUT", "MUT", "WALL", "COST", "TOKENS", "CACHED", "REQ"],
      ...entry.tasks.map((report) => {
        const measured = report.score.outcome === "pass" || report.score.outcome === "fail"
        const seeded = taskById(report.score.taskId)?.mutations.length ?? 0
        return [
          `${report.score.taskId}${entry.tasks.filter((candidate) => candidate.score.taskId === report.score.taskId).length > 1 ? `#${report.attempt}` : ""}`,
          report.score.category,
          report.score.outcome,
          measured ? String(report.score.score) : "—",
          measured ? String(report.score.filesTouched) : "—",
          measured ? String(report.score.outOfScopeFiles.length) : "—",
          report.run.status === "ran" && seeded > 0 ? `${report.run.mutationsCaught}/${seeded}` : "—",
          report.score.wallMs === undefined ? "—" : `${(report.score.wallMs / 1000).toFixed(1)}s`,
          report.score.costUsd === undefined ? "—" : `$${report.score.costUsd.toFixed(4)}`,
          report.score.tokens === undefined ? "—" : compact(totalTokens(report.score.tokens)),
          percent(report.score.tokens && cacheReadShare(report.score.tokens)),
          report.score.requests === undefined ? "—" : String(report.score.requests),
        ]
      }),
    ]
    const summary = entry.aggregate
    const headline =
      summary.measured === 0
        ? `no tasks measured (${summary.unavailable} unavailable, ${summary.errored} harness errors)`
        : [
            `${summary.passed}/${summary.measured} passed`,
            `mean score ${summary.meanScore}`,
            ...(summary.totalCostUsd === undefined ? [] : [`$${summary.totalCostUsd.toFixed(4)} total`]),
            ...(summary.costPerPass === undefined ? [] : [`$${summary.costPerPass.toFixed(4)} per pass`]),
            ...(summary.totalTokens === undefined ? [] : [`${compact(summary.totalTokens)} tokens`]),
            ...(summary.cacheReadShare === undefined ? [] : [`${percent(summary.cacheReadShare)} of input cached`]),
            `${summary.unavailable} unavailable`,
            `${summary.errored} harness errors`,
          ].join(" · ")
    const notes = entry.tasks
      .filter((report) => report.score.outcome !== "pass")
      .map(
        (report) =>
          `    ${report.score.taskId}${entry.tasks.filter((candidate) => candidate.score.taskId === report.score.taskId).length > 1 ? `#${report.attempt}` : ""}: ${explain(report)}`,
      )
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
        const found = entry.tasks.filter((report) => report.score.taskId === task.id)
        if (found.length === 0) return "—"
        const measured = found.filter((report) => report.score.outcome === "pass" || report.score.outcome === "fail")
        if (measured.length === 0 && found.some((report) => report.score.outcome === "error")) return "harness error"
        if (measured.length === 0) return "unavailable"
        const costs = measured.map((report) => report.score.costUsd)
        const cost = costs.every((value) => value !== undefined)
          ? ` · $${(costs.reduce((total, value) => total + value, 0) / costs.length).toFixed(4)}`
          : ""
        const only = found.length === 1 ? measured[0] : undefined
        if (only) return `${only.score.outcome} ${only.score.score}${cost}`
        const passed = measured.filter((report) => report.score.outcome === "pass").length
        const mean = measured.reduce((total, report) => total + report.score.score, 0) / measured.length
        return `${passed}/${measured.length} · ${mean.toFixed(1)}${cost}`
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
  if (!report.score.agentCompleted)
    return `agent did not complete successfully (exit ${report.run.agentExitCode}${report.run.timedOut ? ", timed out" : ""})`
  if (report.run.checkExitCode !== 0) {
    return `check exited ${report.run.checkExitCode}: ${report.checkOutputTail.split("\n").filter(Boolean).slice(-2).join(" | ")}`
  }
  if (report.score.outOfScopeFiles.length > 0) {
    return `passed but touched ${report.score.outOfScopeFiles.join(", ")}`
  }
  return `passed with a discipline or mutation penalty (score ${report.score.score})`
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function percent(value: number | undefined) {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`
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
