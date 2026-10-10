#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { aggregate, scoreTask, type FileDiff, type TaskRun } from "./score"
import { meterLine, type Meter } from "./meter"
import { TASKS, scoringSpec, type EvalTask } from "./tasks"

export type Runtime = "vector" | "codex"
export type Launcher = { command: string; prefix?: string[]; model: string; variant?: string; effort?: string; env?: Record<string, string>; extraArgs?: string[]; kind?: Runtime }
type Config = { vector: Launcher; codex: Launcher; timeoutSeconds?: number; metadata?: Record<string, unknown> }
const ROOT = import.meta.dir
const DEFAULT_TASKS = ["bugfix-idempotent-webhooks", "feature-retry-schedule", "refactor-structured-logging"]
const identity = ["-c", "user.name=Vector Codex Benchmark", "-c", "user.email=benchmark@local.invalid", "-c", "commit.gpgsign=false"]

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parse(line: string) {
  try { return record(JSON.parse(line)) } catch { return undefined }
}

function hash(text: string) { return createHash("sha256").update(text).digest("hex") }

export async function capture(input: { command: string; args: string[]; cwd: string; env?: Record<string, string>; timeoutMs: number; logPrefix: string; sampleMemory?: boolean }) {
  await mkdir(dirname(input.logPrefix), { recursive: true })
  const stdout = createWriteStream(input.logPrefix + ".stdout.log", { mode: 0o600 })
  const stderr = createWriteStream(input.logPrefix + ".stderr.log", { mode: 0o600 })
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const child = spawn(input.command, input.args, { cwd: input.cwd, env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...input.env, PWD: input.cwd }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let meter: Meter = {}
  let timedOut = false
  let spawnError: string | undefined
  let sampledPeakProcessTreeRssKiB = 0
  const trackedProcesses = new Map<number, string>()
  let samples = 0
  let samplePending: Promise<void> | undefined
  let stdoutText = ""
  let stderrText = ""
  let missingVectorPrice = false
  let sawVectorStep = false
  const eventCounts: Record<string, number> = {}
  const toolEvents: Record<string, unknown>[] = []
  const errors: Record<string, unknown>[] = []
  const consumeLine = (line: string) => {
    if (!line.trim()) return
    meter = meterLine(meter, line)
    const event = parse(line)
    if (!event) return
    const type = typeof event.type === "string" ? event.type : "unknown"
    eventCounts[type] = (eventCounts[type] ?? 0) + 1
    const part = record(event.part)
    const item = record(event.item)
    if (type === "step_finish") {
      sawVectorStep = true
      if (typeof part?.cost !== "number") missingVectorPrice = true
    }
    if (type === "error" || type === "turn.failed" || type === "item.failed" || event.error) errors.push(event)
    if (type === "tool_use" || type === "tool_result" || type.startsWith("tool.") || (type === "item.completed" && ["command_execution", "file_change", "mcp_tool_call", "web_search", "tool_call", "collab_tool_call"].includes(String(item?.type)))) toolEvents.push(event)
  }
  const attach = (stream: typeof child.stdout, target: typeof stdout, channel: "stdout" | "stderr") => {
    const decoder = new StringDecoder("utf8")
    let pending = ""
    const consume = (chunk: string) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ""
      lines.forEach(consumeLine)
    }
    stream.on("data", (chunk: Buffer) => {
      target.write(chunk)
      const text = decoder.write(chunk)
      if (channel === "stdout") stdoutText += text
      if (channel === "stderr") stderrText += text
      consume(text)
    })
    stream.on("end", () => { consume(decoder.end()); if (pending) consumeLine(pending) })
  }
  attach(child.stdout, stdout, "stdout")
  attach(child.stderr, stderr, "stderr")
  const processTree = async () => {
    if (!child.pid) return []
    const ps = Bun.spawn(["ps", "-axo", "pid=,ppid=,pgid=,rss=,lstart="], { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(ps.stdout).text()
    if (await ps.exited !== 0) return []
    const processes = text.split("\n").filter(Boolean).map((line) => {
      const fields = line.trim().split(/\s+/)
      return { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), rss: Number(fields[3]) || 0, started: fields.slice(4).join(" ") }
    })
    // Tool shells can create independent process groups. Follow PPID recursively,
    // and keep observed descendants after reparenting while verifying PID identity.
    const descendants = new Set(processes.filter((item) => item.pid === child.pid || trackedProcesses.get(item.pid) === item.started).map((item) => item.pid))
    let priorSize = -1
    while (priorSize !== descendants.size) {
      priorSize = descendants.size
      processes.filter((item) => descendants.has(item.ppid)).forEach((item) => descendants.add(item.pid))
    }
    const selected = processes.filter((item) => descendants.has(item.pid))
    selected.forEach((item) => trackedProcesses.set(item.pid, item.started))
    return selected
  }
  const sample = async () => {
    const total = (await processTree()).reduce((sum, item) => sum + item.rss, 0)
    if (total > 0) { samples += 1; sampledPeakProcessTreeRssKiB = Math.max(sampledPeakProcessTreeRssKiB, total) }
  }
  const takeSample = () => {
    if (samplePending) return
    samplePending = sample().catch(() => {}).finally(() => { samplePending = undefined })
  }
  const sampling = input.sampleMemory ? setInterval(takeSample, 500) : undefined
  if (input.sampleMemory) takeSample()
  const timer = setTimeout(async () => {
    timedOut = true
    if (!child.pid) return
    const descendants = await processTree().catch(() => [])
    // Kill children in all observed groups before the direct child. A final group
    // kill catches children created between the final snapshot and termination.
    descendants.filter((item) => item.pid !== child.pid).reverse().forEach((item) => {
      try { process.kill(item.pid, "SIGKILL") } catch {}
    })
    try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
  }, input.timeoutMs)
  const completion = await new Promise<{ exitCode: number; signal: string | null }>((resolve) => {
    child.once("error", (error) => { spawnError = error.message })
    child.once("close", (code, signal) => resolve({ exitCode: timedOut ? 124 : (code ?? 127), signal }))
  })
  clearTimeout(timer)
  if (sampling) clearInterval(sampling)
  await samplePending
  await Promise.all([new Promise<void>((resolve) => stdout.end(resolve)), new Promise<void>((resolve) => stderr.end(resolve))])
  const result = {
    ...completion, timedOut, spawnError, startedAt, completedAt: new Date().toISOString(), wallMs: Math.round(performance.now() - started),
    stdoutPath: input.logPrefix + ".stdout.log", stderrPath: input.logPrefix + ".stderr.log",
    meter: { ...meter, costUsd: sawVectorStep && missingVectorPrice ? undefined : meter.costUsd },
    reportedCostKnown: meter.costUsd !== undefined && !missingVectorPrice,
    costMeaning: "Runtime-reported value only; not a billing invoice. Missing prices remain unknown.",
    sampledPeakProcessTreeRssKiB: samples ? sampledPeakProcessTreeRssKiB : null,
    memorySamples: samples,
    observedProcessCount: trackedProcesses.size,
    memoryMethod: "Sum of RSS for CLI and descendants discovered recursively by PPID, sampled every 500ms; observed reparented descendants remain tracked by PID plus start time. Shared pages may count more than once; descendants that detach before observation may be omitted.",
    eventCounts, toolEventCount: toolEvents.length, toolEvents, reportedErrors: errors,
  }
  await writeFile(input.logPrefix + ".json", JSON.stringify(result, null, 2) + "\n")
  return { ...result, stdoutText, stderrText }
}

async function git(cwd: string, args: string[], logPrefix: string) {
  const result = await capture({ command: "git", args, cwd, timeoutMs: 60_000, logPrefix })
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderrText.slice(-2000)}`)
  return result.stdoutText.trimEnd()
}

export function argumentsFor(runtime: Runtime, launcher: Launcher, fixture: string, prompt: string) {
  if ((launcher.kind ?? runtime) === "vector") return [...(launcher.prefix ?? []), "run", "--dir", fixture, "--format", "json", "--auto", "--model", launcher.model, ...(launcher.variant ? ["--variant", launcher.variant] : []), ...(launcher.extraArgs ?? []), prompt]
  return [...(launcher.prefix ?? []), "exec", "--ignore-user-config", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", fixture, "--model", launcher.model, ...(launcher.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(launcher.effort)}`] : []), ...(launcher.extraArgs ?? []), prompt]
}

export async function runTask(runtime: Runtime, launcher: Launcher, task: EvalTask, attempt: number, root: string, timeoutMs: number) {
  const artifact = join(root, task.id, String(attempt), runtime)
  const fixture = join(artifact, "fixture")
  await mkdir(fixture, { recursive: true })
  await Promise.all(Object.entries(task.files).map(async ([path, content]) => { await mkdir(dirname(join(fixture, path)), { recursive: true }); await writeFile(join(fixture, path), content) }))
  await writeFile(join(artifact, "prompt.txt"), task.prompt + "\n")
  await git(fixture, ["-c", "init.defaultBranch=benchmark", "init", "--quiet"], join(artifact, "git-init"))
  await git(fixture, [...identity, "add", "-A"], join(artifact, "git-baseline-add"))
  await git(fixture, [...identity, "commit", "--quiet", "-m", "baseline"], join(artifact, "git-baseline-commit"))
  const baseline = await git(fixture, ["rev-parse", "HEAD"], join(artifact, "git-baseline-head"))
  const argv = argumentsFor(runtime, launcher, fixture, task.prompt)
  await writeFile(join(artifact, "invocation.json"), JSON.stringify({ command: launcher.command, args: argv, cwd: fixture, environmentOverrides: Object.keys(launcher.env ?? {}), timeoutMs }, null, 2) + "\n")
  const before = await capture({ command: task.check.command, args: task.check.args, cwd: fixture, timeoutMs: 120_000, logPrefix: join(artifact, "baseline-check") })
  process.stdout.write(`${runtime}/${task.id}/${attempt}: running\n`)
  const agent = await capture({ command: launcher.command, args: argv, cwd: fixture, env: launcher.env, timeoutMs, sampleMemory: true, logPrefix: join(artifact, "agent") })
  await git(fixture, [...identity, "add", "-A"], join(artifact, "git-final-add"))
  const diff: FileDiff[] = (await git(fixture, ["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", "--cached", baseline], join(artifact, "git-numstat"))).split(/\r?\n/).filter(Boolean).map((line) => { const columns = line.split("\t"); return { path: columns.slice(2).join("\t"), added: Number(columns[0]) || 0, removed: Number(columns[1]) || 0 } })
  await writeFile(join(artifact, "final.patch"), await git(fixture, ["diff", "--binary", "--cached", baseline], join(artifact, "git-patch")) + "\n")
  const protectedChecks = await Promise.all(task.protectedFiles.map(async (path) => { const actual = await readFile(join(fixture, path), "utf8").catch(() => undefined); return { path, baselineSha256: hash(task.files[path]!), finalSha256: actual === undefined ? null : hash(actual), unchanged: actual === task.files[path] } }))
  const protectedViolations = protectedChecks.filter((item) => !item.unchanged).map((item) => item.path)
  const assertionFailures = (await Promise.all(task.assertions.map(async (assertion) => {
    const content = await readFile(join(fixture, assertion.path), "utf8").catch(() => undefined)
    if (content === undefined) return assertion.exists === false ? [] : [`${assertion.path} is missing`]
    if (assertion.exists === false) return [`${assertion.path} should not exist`]
    return [...(assertion.includes ?? []).filter((value) => !content.includes(value)).map((value) => `${assertion.path} missing ${value}`), ...(assertion.excludes ?? []).filter((value) => content.includes(value)).map((value) => `${assertion.path} contains ${value}`)]
  }))).flat()
  const check = await capture({ command: task.check.command, args: task.check.args, cwd: fixture, timeoutMs: 120_000, logPrefix: join(artifact, "final-check") })
  let mutationsCaught = 0
  if (check.exitCode === 0 && protectedViolations.length === 0 && assertionFailures.length === 0) {
    for (const mutation of task.mutations) {
      const original = await readFile(join(fixture, mutation.path), "utf8")
      if (!original.includes(mutation.find)) continue
      await writeFile(join(fixture, mutation.path), original.replace(mutation.find, mutation.replace))
      const result = await capture({ command: task.check.command, args: task.check.args, cwd: fixture, timeoutMs: 120_000, logPrefix: join(artifact, "mutation-" + mutation.id) })
      await writeFile(join(fixture, mutation.path), original)
      if (result.exitCode !== 0) mutationsCaught += 1
    }
  }
  const unusable = diff.length === 0 && (agent.exitCode !== 0 || agent.reportedErrors.length > 0) && /not (?:logged in|authenticated|signed in)|invalid.*api.?key|missing.*api.?key|unauthorized|model.{0,100}(?:not found|does not exist|unavailable|not available|not supported)|invalid_request_error|rate.?limit|insufficient.*(?:quota|credit)|quota.{0,20}(?:exceeded|exhausted)|no providers|no model/i.test(agent.stdoutText + agent.stderrText)
  const run: TaskRun = unusable ? { taskId: task.id, runtime, status: "unavailable", detail: "Runtime reported authentication, provider, model, or quota failure without edits; inspect agent logs." } : { taskId: task.id, runtime, status: "ran", wallMs: agent.wallMs, agentExitCode: agent.exitCode, checkExitCode: check.exitCode, diff, protectedViolations, assertionFailures, mutationsCaught, costUsd: agent.meter.costUsd, tokens: agent.meter.tokens, requests: agent.meter.requests }
  const score = scoreTask(scoringSpec(task), run)
  const { stdoutText, stderrText, ...agentMetadata } = agent
  const result = { runtime, taskId: task.id, attempt, artifact, fixture, baseline, promptSha256: hash(task.prompt), fixtureFileHashes: Object.fromEntries(Object.entries(task.files).map(([path, content]) => [path, hash(content)])), baselineCheckExitCode: before.exitCode, baselineCheckTimedOut: before.timedOut, run, score, protectedChecks, agent: agentMetadata, finalCheckExitCode: check.exitCode, finalCheckTimedOut: check.timedOut, normalCompletion: agent.exitCode === 0 && !agent.timedOut && agent.reportedErrors.length === 0 }
  await writeFile(join(artifact, "result.json"), JSON.stringify(result, null, 2) + "\n")
  process.stdout.write(`${runtime}/${task.id}/${attempt}: ${score.outcome} score=${score.score} ${agent.wallMs / 1000}s files=${score.filesTouched} lines=${score.linesTouched}\n`)
  return result
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) { process.stdout.write("Usage: bun runner.ts --config config.json [--repeat 1] [--tasks id,id] [--run-id label]\nAlso: --list. No implicit retries. Default tasks: " + DEFAULT_TASKS.join(",") + "\n"); return }
  if (args.includes("--list")) { process.stdout.write(TASKS.map((task) => `${task.id}\t${task.title}`).join("\n") + "\n"); return }
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const configPath = value("--config")
  if (!configPath) throw new Error("--config path is required")
  const config = await Bun.file(configPath).json() as Config
  const repeats = Number(value("--repeat") ?? 1)
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("--repeat must be 1–20")
  const requested = value("--tasks")?.split(",") ?? DEFAULT_TASKS
  const tasks = requested.map((id) => { const task = TASKS.find((task) => task.id === id); if (!task) throw new Error(`Unknown task: ${id}`); return task })
  for (const runtime of ["vector", "codex"] as const) if (!config[runtime]?.command || !config[runtime]?.model) throw new Error(`${runtime} command/model required in config`)
  const timeoutMs = (config.timeoutSeconds ?? 600) * 1000
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) throw new Error("timeoutSeconds must be positive")
  const runId = value("--run-id") ?? new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error("--run-id must contain only letters, digits, period, underscore, hyphen")
  const root = join(ROOT, "runs", runId)
  await mkdir(root, { recursive: true })
  if (await Bun.file(join(root, "report.json")).exists()) throw new Error("Report already exists; use a fresh run id")
  const results: Awaited<ReturnType<typeof runTask>>[] = []
  const report = { startedAt: new Date().toISOString(), completedAt: null as string | null, status: "running", platform: `${process.platform}-${process.arch}`, bun: Bun.version, root, repetitions: repeats, tasks: requested, timeoutMs, metadata: config.metadata, configuration: Object.fromEntries((["vector", "codex"] as const).map((runtime) => { const { env, ...settings } = config[runtime]; return [runtime, { ...settings, environmentOverrideKeys: Object.keys(env ?? {}) }] })), limitations: ["Local synthetic fixtures; not broad repository performance", "Costs are runtime-reported or unknown; not actual invoiced subscription cost", "RSS sampled every 500ms over recursively tracked process tree; not total allocated memory", "Tool event counts reflect runtime event schemas and are not directly equivalent", "Task pass uses objective final-tree checks even if CLI exits nonzero; normalCompletion tracked separately"], results, aggregates: {} }
  const save = async () => { report.aggregates = Object.fromEntries((["vector", "codex"] as const).map((runtime) => [runtime, aggregate(runtime, results.filter((result) => result.runtime === runtime).map((result) => result.score))])); await writeFile(join(root, "report.json.tmp"), JSON.stringify(report, null, 2) + "\n"); await rename(join(root, "report.json.tmp"), join(root, "report.json")) }
  await save()
  process.stdout.write(`Report: ${join(root, "report.json")}\n`)
  for (const attempt of Array.from({ length: repeats }, (_, index) => index + 1)) {
    for (const [taskIndex, task] of tasks.entries()) {
      const order: Runtime[] = (attempt + taskIndex) % 2 ? ["vector", "codex"] : ["codex", "vector"]
      for (const runtime of order) { results.push(await runTask(runtime, config[runtime], task, attempt, root, timeoutMs)); await save() }
    }
  }
  report.status = "complete"
  report.completedAt = new Date().toISOString()
  await save()
  process.stdout.write(`Complete: ${join(root, "report.json")}\n`)
}

if (import.meta.main) await main()
