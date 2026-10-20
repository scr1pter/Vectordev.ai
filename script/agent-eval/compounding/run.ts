#!/usr/bin/env bun
// The brain compounding benchmark: nineteen tasks over seven simulated weeks on one repository, with Vector's brain off
// and on, and a control arm that keeps the brain on but hides what it adds from the model.
//
//   bun script/agent-eval/compounding/run.ts                          offline: all three arms, report in a temp folder
//   bun script/agent-eval/compounding/run.ts --out <folder>           write README.md and report.json there
//   bun script/agent-eval/compounding/run.ts --arms off,on --tasks t01-slugify,t08-csv-export
//   bun script/agent-eval/compounding/run.ts --render <folder>/report.json   the README again from a report's data
//   bun script/agent-eval/compounding/run.ts --live --provider openai-compatible --base-url http://localhost:8000/v1 \
//     --model kimi-k3 --max-spend 5 [--yes]
//   bun script/agent-eval/compounding/run.ts --live --provider anthropic --model claude-sonnet-4-5 \
//     --api-key-env ANTHROPIC_API_KEY --price-input 3 --price-output 15 --max-spend 20 [--yes]
//
// Offline it needs no network and no key: a scripted model on a local fake server answers every request. Live runs
// the same sequence against a model the owner configures, shows a cost estimate first, and stops at a hard spend cap
// counted from the tokens the provider reports at the prices given; it never runs in CI, and it refuses a paid
// provider without prices. Live, the model gets a shell with every permission: run it in a container or a throwaway
// machine (see the README).

import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { cpus, loadavg, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ARMS, REPO_ROOT, runArm, type Arm, type Provider, type TaskRun } from "./harness"
import { json, markdown } from "./report"
import { TASKS } from "./tasks"

const argv = process.argv.slice(2)

// `--render <report.json>` writes the README beside a report again from its data, after a change to the page's wording.
const rendering = argv[argv.indexOf("--render") + 1]
if (argv.includes("--render") && rendering) {
  const report = await Bun.file(rendering).json()
  const meta = { date: report.date, mode: report.mode, model: report.model, revision: report.revision, machine: report.machine, command: report.command, seconds: report.seconds }
  const arms = Object.fromEntries(Object.entries(report.arms as Record<string, { tasks: TaskRun[] }>).map(([arm, value]) => [arm, value.tasks]))
  await writeFile(join(resolve(rendering, ".."), "README.md"), markdown(meta, arms))
  process.exit(0)
}
const flag = (name: string) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const has = (name: string) => argv.includes(`--${name}`)

const live = has("live")
const arms = (flag("arms")?.split(",") ?? (live ? ["off", "on"] : [...ARMS])) as Arm[]
const unknown = arms.filter((arm) => !ARMS.includes(arm))
if (unknown.length) fail(`Unknown arm ${unknown.join(", ")}. Arms: ${ARMS.join(", ")}`)
if (live && arms.includes("blind")) fail("The control arm needs the scripted model; it runs offline only.")
const tasks = flag("tasks")?.split(",")
const missing = (tasks ?? []).filter((id) => !TASKS.some((task) => task.id === id))
if (missing.length) fail(`Unknown task ${missing.join(", ")}. Tasks: ${TASKS.map((task) => task.id).join(", ")}`)
// Live, the provider and the estimate come first, so a run that stops there leaves no folder behind.
const provider = live ? await liveProvider() : undefined
const work = await folder(flag("work") ?? (await mkdtemp(join(tmpdir(), "vector-compounding-"))))
const now = new Date()
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
const out = resolve(flag("out") ?? join(tmpdir(), `vector-compounding-${date}-${Date.now()}`))

const started = performance.now()
process.stderr.write(`Running ${arms.join(", ")} over ${tasks?.length ?? TASKS.length} tasks in ${work}\n`)
// Offline arms are independent, so they run side by side; live arms run one after the other under one spend cap.
const runs = live
  ? await sequential(arms)
  : Object.fromEntries(await Promise.all(arms.map(async (arm) => [arm, await runArm(options(arm))] as const)))
const seconds = (performance.now() - started) / 1000
if (!has("keep") && !flag("work")) await rm(work, { recursive: true, force: true })

const meta = {
  date,
  mode: live ? ("live" as const) : ("offline" as const),
  model: provider?.model ?? "scripted model on a local fake Anthropic Messages server",
  revision: (Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim() || "unknown"),
  machine: `${cpus()[0]?.model ?? "unknown CPU"}, ${cpus().length} cores, ${process.platform} ${process.arch}, Bun ${Bun.version}, one-minute load average ${loadavg()[0]!.toFixed(1)} at the end`,
  command: ["bun script/agent-eval/compounding/run.ts", ...argv].join(" "),
  seconds,
}
await mkdir(out, { recursive: true })
await writeFile(join(out, "report.json"), `${JSON.stringify(json(meta, runs), null, 2)}\n`)
await writeFile(join(out, "README.md"), markdown(meta, runs))
process.stdout.write(`${summary(runs)}\nReport: ${join(out, "README.md")}\n`)
const broken = Object.values(runs).flat().filter((run) => run.scriptError || run.exitCode !== 0)
if (!live && broken.length) {
  process.stderr.write(`Invalid offline runs: ${broken.map((run) => `${run.arm}/${run.task}: ${run.scriptError ?? `exit ${run.exitCode}`}`).join("; ")}\n`)
  process.exitCode = 1
}

function options(arm: Arm) {
  return {
    arm,
    // Folders of one length, so the paths in the requests cost every arm the same tokens.
    root: join(work, arm.padEnd(5, "_")),
    ...(tasks ? { tasks } : {}),
    ...(flag("dump") ? { dump: resolve(flag("dump")!) } : {}),
    onTask: (run: TaskRun) =>
      process.stderr.write(
        `  ${arm.padEnd(5)} ${run.task.padEnd(24)} ${String(run.inputTokens).padStart(7)} tokens ${String(run.steps).padStart(3)} steps ${run.success ? "pass" : "FAIL"}${run.mistakes.length ? `  wrong: ${run.mistakes.map((item) => item.fact).join(", ")}` : ""}${run.scriptError ? `  SCRIPT ERROR: ${run.scriptError}` : ""}\n`,
      ),
  }
}

// Live: one arm at a time. Spend is counted from each step's reported tokens at the given prices: a task is stopped once
// its own spend reaches what is left of the cap, and no task starts after that. Vector's Run Guard gets the same rest as
// `--max-cost`, a second stop that counts at the same prices.
async function sequential(list: readonly Arm[]) {
  const cap = Number(flag("max-spend") ?? 5)
  let spent = 0
  const result: Partial<Record<Arm, TaskRun[]>> = {}
  for (const arm of list) {
    result[arm] = await runArm({
      ...options(arm),
      provider: { ...provider!, maxCost: () => Math.max(0.01, Math.round((cap - spent) * 100) / 100), remaining: () => cap - spent },
      stop: () => spent >= cap,
      onTask: (run) => {
        spent += run.costUsd
        options(arm).onTask(run)
        process.stderr.write(`        spent $${spent.toFixed(4)} of the $${cap.toFixed(2)} cap\n`)
      },
    })
    if (spent >= cap) process.stderr.write(`Stopped: the $${cap.toFixed(2)} spend cap is reached.\n`)
  }
  return result
}

// The provider entry `vector run` gets for a live run, after the cost estimate and only with --yes. A key comes from the
// environment variable the owner names and goes only into the child's configuration; it is never printed or saved.
async function liveProvider(): Promise<Provider> {
  if (process.env.CI) fail("The live benchmark never runs in CI: it calls a real model.")
  const kind = flag("provider") ?? "openai-compatible"
  if (!["anthropic", "openai", "openai-compatible"].includes(kind)) fail(`Unknown provider ${kind}: anthropic, openai or openai-compatible`)
  const model = flag("model") ?? fail("--model is required with --live")
  const base = flag("base-url")
  if (kind === "openai-compatible" && !base) fail("--base-url is required for an OpenAI-compatible endpoint")
  // Only an endpoint on this machine may run unpriced: anything else bills by the token.
  const local = kind === "openai-compatible" && ["localhost", "127.0.0.1", "[::1]"].includes(URL.parse(base!)?.hostname ?? "")
  const priced = (name: string) => {
    const value = flag(name)
    if (value === undefined) return undefined
    const number = Number(value)
    return number >= 0 ? number : fail(`--${name} must be a number of US dollars per million tokens`)
  }
  const input = priced("price-input") ?? 0
  const output = priced("price-output") ?? 0
  // Without prices every step counts as $0, and the cap would never stop a paid model.
  if (!local && !(input > 0 && output > 0))
    fail(
      `${kind === "openai-compatible" ? `${base} is not an endpoint on this machine` : `${kind} bills by the token`}: give --price-input and --price-output (US dollars per million tokens), so the spend cap can count what the run spends. Without them every step counts as $0 and the cap never stops it.`,
    )
  const keyEnv = flag("api-key-env")
  const key = keyEnv ? (process.env[keyEnv] ?? fail(`${keyEnv} is not set`)) : undefined
  const cap = Number(flag("max-spend") ?? 5)
  if (!(cap > 0)) fail("--max-spend must be a positive number of US dollars")
  // Anthropic bills cache reads at a tenth and writes at 1.25 times input; elsewhere reads count at half, to stay on the
  // safe side of the cap, and writes as input.
  const rates = {
    input,
    output,
    cacheRead: priced("price-cache-read") ?? (kind === "anthropic" ? input / 10 : input / 2),
    cacheWrite: kind === "anthropic" ? input * 1.25 : input,
  }
  const footprint = await offlineFootprint()
  const count = (tasks?.length ?? TASKS.length) * arms.length
  // A real model takes more turns than the script and writes more: one to three times the scripted input, and about
  // 1,500 output tokens a task.
  const low = (footprint * input + count * 1_500 * output) / 1_000_000
  const high = (footprint * 3 * input + count * 1_500 * output) / 1_000_000
  process.stderr.write(
    [
      `Live run: ${count} task runs (${arms.join(", ")}) on ${kind}/${model}.`,
      input === 0 && output === 0
        ? `Estimated cost: $0. ${base} is on this machine and no prices were given, so every step counts as $0 and the spend cap limits nothing: each task stops only at 40 steps. If this endpoint forwards to a paid service, give its prices.`
        : `Estimated cost: $${low.toFixed(2)} to $${high.toFixed(2)} (the offline footprint of ${footprint.toLocaleString("en-US")} input tokens, one to three times over, at $${input}/$${output} per million).`,
      input === 0 && output === 0
        ? `Hard cap: $${cap.toFixed(2)}, which counts nothing at $0 a token.`
        : `Hard cap: $${cap.toFixed(2)}, counted from the tokens the provider reports at these prices. A task stops at the step that reaches what is left (that one step can take it past the cap), and no task starts once it is spent.`,
      "The model gets a shell with every permission. Run this inside a container or a throwaway machine.",
      "",
    ].join("\n"),
  )
  if (Math.max(low, 0) > cap) fail(`Even the low estimate is over the $${cap.toFixed(2)} cap. Raise --max-spend or run fewer --tasks.`)
  if (!has("yes")) {
    process.stderr.write("Nothing was run. Add --yes to start.\n")
    process.exit(0)
  }
  // The model is declared here, with the prices given, so Vector's Run Guard counts spend at the same rates as the
  // estimate and the cap.
  const id = kind === "openai-compatible" ? "local" : kind
  return {
    model: `${id}/${model}`,
    config: {
      [id]: {
        name: kind === "openai-compatible" ? "Local model" : kind === "anthropic" ? "Anthropic" : "OpenAI",
        id,
        env: [],
        npm: kind === "openai-compatible" ? "@ai-sdk/openai-compatible" : `@ai-sdk/${kind}`,
        options: { apiKey: key ?? "local", ...(base ? { baseURL: base } : {}) },
        models: {
          [model]: {
            id: model,
            name: model,
            tool_call: true,
            attachment: kind !== "openai-compatible",
            reasoning: kind !== "openai-compatible",
            temperature: true,
            release_date: "2026-01-01",
            limit: { context: Number(flag("context") ?? (kind === "openai-compatible" ? 131_072 : 200_000)), output: 16_384 },
            cost: { input, output, cache_read: rates.cacheRead, cache_write: rates.cacheWrite },
            options: {},
          },
        },
      },
    },
    rates,
  }
}

// A work folder as its real path, made if it is not there yet (see runArm).
async function folder(path: string) {
  await mkdir(resolve(path), { recursive: true })
  return realpath(resolve(path))
}

// Input tokens the offline arms sent for these tasks, from the newest committed offline report (about 68,000 a task
// without one), as the base of the estimate.
async function offlineFootprint() {
  const folder = join(REPO_ROOT, "docs", "benchmarks")
  const newest = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.startsWith("vector-compounding-")).toSorted().at(-1)
  const report = newest ? await Bun.file(join(folder, newest, "report.json")).json().catch(() => undefined) : undefined
  const perTask = (arm: Arm) => {
    const totals = report?.arms?.[arm]?.totals
    return totals?.tasks ? totals.inputTokens / totals.tasks : 68_000
  }
  return Math.round(arms.reduce((total, arm) => total + perTask(arm) * (tasks?.length ?? TASKS.length), 0))
}

function summary(result: Partial<Record<Arm, readonly TaskRun[]>>) {
  return (Object.entries(result) as [Arm, readonly TaskRun[]][])
    .map(([arm, list]) => {
      const tokens = list.reduce((total, run) => total + run.inputTokens, 0)
      const steps = list.reduce((total, run) => total + run.steps, 0)
      const repeated = list.reduce((total, run) => total + run.mistakes.filter((item) => item.repeated).length, 0)
      const passed = list.filter((run) => run.success).length
      return `${arm.padEnd(5)} ${tokens.toLocaleString("en-US").padStart(9)} input tokens  ${String(steps).padStart(4)} steps  ${repeated} repeated mistakes  ${passed}/${list.length} tasks passed`
    })
    .join("\n")
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}
