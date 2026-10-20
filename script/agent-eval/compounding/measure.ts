// What a task run cost and how it went, from what the run left behind: the requests the model was sent (offline), the
// run's JSON event stream (every mode), and the hidden acceptance tests. Pure, so a recorded run can be measured again.
// Mistakes are read from what the agent did and what the acceptance tests found, never from the scripted model's own
// account, so offline and live runs are measured by the same rules.

import { meterLine, type Meter } from "../meter"
import { createPromptCache, estimate, price, strip, type Rates, type Recorded } from "../prompt-cache"
import { brainSpans } from "./policy"
import { FACTS, TASKS, type FactID, type Task } from "./tasks"

/** Claude Sonnet 4.5 list prices per million tokens, with 5-minute cache writes; offline requests are priced at them. */
export const RATES: Rates = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }

export type Step = { readonly tool: string; readonly input: Record<string, unknown>; readonly output: string; readonly exit?: number }

/** The tool calls a run made, from `vector run --format json`. */
export function transcript(stdout: string): Step[] {
  return stdout.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return []
    const event = parse(line)
    if (event?.type !== "tool_use") return []
    const part = event.part as { tool?: string; state?: { input?: Record<string, unknown>; output?: unknown; error?: unknown; metadata?: Record<string, unknown> } }
    const output = typeof part.state?.output === "string" ? part.state.output : typeof part.state?.error === "string" ? part.state.error : ""
    const exit = typeof part.state?.metadata?.exit === "number" ? part.state.metadata.exit : exitOf(output)
    return [{ tool: String(part.tool ?? ""), input: part.state?.input ?? {}, output, ...(exit === undefined ? {} : { exit }) }]
  })
}

function exitOf(output: string) {
  const match = /Command exited with code (\d+)/.exec(output)
  return match ? Number(match[1]) : undefined
}

function parse(line: string) {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export type Acceptance = { readonly name: string; readonly passed: boolean }[]

/** The hidden acceptance tests' results, from bun's JUnit report. */
export function junit(xml: string): Acceptance {
  return [...xml.matchAll(/<testcase name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)].map((match) => ({
    name: decode(match[1]!),
    passed: match[2] === "/>" || !/<(failure|error)\b/.test(match[3] ?? ""),
  }))
}

function decode(text: string) {
  return text.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

export type Mistake = { readonly fact: FactID; readonly how: string; readonly repeated: boolean }

/**
 * Mistakes in one task: a command or a broken check that shows a fact was missing, or a hidden acceptance test of a
 * fact that failed. A mistake is repeated when an earlier task in the sequence already taught the fact.
 */
export function mistakes(task: Task, steps: readonly Step[], acceptance: Acceptance): Mistake[] {
  const index = TASKS.findIndex((item) => item.id === task.id)
  const shell = steps.filter((step) => step.tool === "bash")
  // At most one per fact and task: the first sign of it.
  const signs: { fact: FactID; how: string }[] = [
    ...shell
      .filter((step) => /(?:^|[;&|]\s*)npm\s+(?:install|i|add)\b/.test(String(step.input.command ?? "")))
      .map((step) => ({ fact: "pnpm" as const, how: `ran \`${String(step.input.command)}\`` })),
    ...shell
      .filter((step) => /routes\.gen\.ts is stale/.test(step.output))
      .map(() => ({ fact: "routes" as const, how: "the check failed on a stale src/generated/routes.gen.ts" })),
    ...acceptance
      .filter((test) => !test.passed && test.name.startsWith("fact:"))
      .map((test) => ({ fact: test.name.slice(5) as FactID, how: `the hidden check ${test.name} failed` })),
  ]
  return signs
    .filter((item, at) => signs.findIndex((other) => other.fact === item.fact) === at)
    .map((item) => ({ ...item, repeated: taughtBefore(item.fact, index) }))
}

/** Whether a task before this one taught the fact. */
export function taughtBefore(id: FactID, index: number) {
  const first = TASKS.findIndex((item) => item.teaches.some((teach) => teach.fact === id))
  return first >= 0 && first < index
}

export type TaskMetrics = {
  readonly task: string
  readonly week: number
  /** Provider requests, the model's tool calls, and the files it read. */
  readonly requests: number
  readonly steps: number
  readonly reads: number
  /** Reads of a file this arm already read in an earlier task or earlier in this one. */
  readonly rereads: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Tokens of what Vector's memory added to the requests (recall, digest, file notes, pointers, memory results). */
  readonly memoryTokens: number
  /** Tokens of the memory tool's definition, which every request offering it carries. */
  readonly memoryToolTokens: number
  /** The model's own calls to the memory tool: saving what it learned, opening what a pointer named. */
  readonly memoryCalls: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly costUsd: number
  readonly mistakes: readonly Mistake[]
  readonly checks: { readonly passed: number; readonly total: number; readonly failed: readonly string[] }
  readonly success: boolean
  /** The facts the task needed that were in the model's first request, and what brought each one. */
  readonly delivered: readonly FactID[]
}

/** One task's metrics. `earlier` is every file the arm read in tasks before this one. */
export function measure(input: {
  readonly task: Task
  readonly requests?: readonly Recorded[]
  readonly stdout: string
  readonly dir: string
  readonly acceptance: Acceptance
  readonly earlier: ReadonlySet<string>
  readonly rates?: Rates
}): TaskMetrics & { readonly read: readonly string[] } {
  const steps = transcript(input.stdout)
  const read = steps.flatMap((step) => {
    if (step.tool !== "read") return []
    const file = String(step.input.filePath ?? step.input.file_path ?? "")
    return [file.startsWith(input.dir) ? file.slice(input.dir.length + 1) : file]
  })
  const rereads = read.filter((file, at) => input.earlier.has(file) || read.indexOf(file) < at).length
  const offline = input.requests
  // Offline: what the model was sent, priced with a cold cache per task (days apart, a provider's cache is gone).
  const costs = offline ? price([...offline], createPromptCache(), input.rates ?? RATES) : []
  const meter = input.stdout.split("\n").reduce<Meter>((sum, line) => meterLine(sum, line), {})
  const sum = (pick: (cost: (typeof costs)[number]) => number) => costs.reduce((total, cost) => total + pick(cost), 0)
  const first = offline?.find((request) => Array.isArray(request.body.tools) && request.body.tools.length > 0)
  const text = (request: Recorded) => JSON.stringify(request.body)
  const memoryTokens = offline
    ? offline.reduce((total, request) => total + estimate(brainSpans(unescape(text(request))).join("")), 0)
    : 0
  const failed = input.acceptance.filter((test) => !test.passed).map((test) => test.name)
  return {
    task: input.task.id,
    week: input.task.week,
    requests: offline ? offline.length : (meter.requests ?? 0),
    steps: steps.length,
    reads: read.length,
    rereads,
    read,
    inputTokens: offline ? sum((cost) => cost.inputTokens) : (meter.tokens ? meter.tokens.input + meter.tokens.cacheRead + meter.tokens.cacheWrite : 0),
    outputTokens: offline ? sum((cost) => cost.outputTokens) : (meter.tokens?.output ?? 0),
    memoryTokens,
    memoryToolTokens: (offline ?? []).reduce((total, request) => {
      const tool = (Array.isArray(request.body.tools) ? request.body.tools : []).find((item) => item?.name === "memory")
      return total + (tool ? estimate(strip(tool)) : 0)
    }, 0),
    memoryCalls: steps.filter((step) => step.tool === "memory").length,
    cacheRead: offline ? sum((cost) => cost.cacheRead) : (meter.tokens?.cacheRead ?? 0),
    cacheWrite: offline ? sum((cost) => cost.cacheWrite) : (meter.tokens?.cacheWrite ?? 0),
    costUsd: offline ? Math.round(sum((cost) => cost.costUsd) * 1e6) / 1e6 : (meter.costUsd ?? 0),
    mistakes: mistakes(input.task, steps, input.acceptance),
    checks: { passed: input.acceptance.length - failed.length, total: input.acceptance.length, failed },
    success: input.acceptance.length > 0 && failed.length === 0,
    delivered: first
      ? input.task.needs.filter((id) => FACTS.find((item) => item.id === id)!.marker.test(brainSpans(unescape(text(first))).join("\n")))
      : [],
  }
}

// A request body as JSON escapes its newlines and quotes; the brain's spans are matched in the text itself.
function unescape(json: string) {
  return json.replaceAll("\\n", "\n").replaceAll('\\"', '"')
}

export type Totals = {
  readonly tasks: number
  readonly requests: number
  readonly steps: number
  readonly reads: number
  readonly rereads: number
  readonly inputTokens: number
  readonly memoryTokens: number
  readonly memoryToolTokens: number
  readonly memoryCalls: number
  readonly costUsd: number
  readonly mistakes: number
  readonly repeated: number
  readonly checksPassed: number
  readonly checksTotal: number
  readonly succeeded: number
}

export function totals(rows: readonly TaskMetrics[]): Totals {
  const sum = (pick: (row: TaskMetrics) => number) => rows.reduce((total, row) => total + pick(row), 0)
  return {
    tasks: rows.length,
    requests: sum((row) => row.requests),
    steps: sum((row) => row.steps),
    reads: sum((row) => row.reads),
    rereads: sum((row) => row.rereads),
    inputTokens: sum((row) => row.inputTokens),
    memoryTokens: sum((row) => row.memoryTokens),
    memoryToolTokens: sum((row) => row.memoryToolTokens),
    memoryCalls: sum((row) => row.memoryCalls),
    costUsd: Math.round(sum((row) => row.costUsd) * 1e6) / 1e6,
    mistakes: sum((row) => row.mistakes.length),
    repeated: sum((row) => row.mistakes.filter((item) => item.repeated).length),
    checksPassed: sum((row) => row.checks.passed),
    checksTotal: sum((row) => row.checks.total),
    succeeded: sum((row) => (row.success ? 1 : 0)),
  }
}

/** Per week, and running totals to the end of each week: the chart-ready table. */
export function weekly(rows: readonly TaskMetrics[]) {
  const weeks = [...new Set(rows.map((row) => row.week))].toSorted((a, b) => a - b)
  return weeks.map((week) => ({
    week,
    week_totals: totals(rows.filter((row) => row.week === week)),
    cumulative: totals(rows.filter((row) => row.week <= week)),
  }))
}
