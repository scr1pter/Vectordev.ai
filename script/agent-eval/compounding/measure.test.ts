import { describe, expect, test } from "bun:test"
import { junit, measure, mistakes, spend, transcript, weekly, type TaskMetrics } from "./measure"
import { TASKS } from "./tasks"

const task = (id: string) => TASKS.find((item) => item.id === id)!

const event = (tool: string, input: Record<string, unknown>, output: string, exit?: number) =>
  JSON.stringify({ type: "tool_use", part: { tool, state: { status: "completed", input, output, metadata: exit === undefined ? {} : { exit } } } })

describe("measuring a run", () => {
  test("reads tool calls and exit codes from vector run's JSON events", () => {
    const steps = transcript(
      [
        "not json",
        event("bash", { command: "npm run check" }, "check failed", 1),
        JSON.stringify({ type: "step_finish", part: {} }),
        event("read", { filePath: "/r/src/a.ts" }, "1: x"),
      ].join("\n"),
    )
    expect(steps).toEqual([
      { tool: "bash", input: { command: "npm run check" }, output: "check failed", exit: 1 },
      { tool: "read", input: { filePath: "/r/src/a.ts" }, output: "1: x" },
    ])
  })

  test("reads which hidden checks passed from bun's JUnit report", () => {
    const xml = `<testsuite><testcase name="suite" time="0" /><testcase name="fact:cents" time="0"><failure type="AssertionError" /></testcase><testcase name="fact:&quot;x&quot;" /></testsuite>`
    expect(junit(xml)).toEqual([
      { name: "suite", passed: true },
      { name: "fact:cents", passed: false },
      { name: 'fact:"x"', passed: true },
    ])
  })

  test("counts an npm install, a stale route table and a failed fact check, once per fact", () => {
    const steps = transcript(
      [
        event("bash", { command: "npm install tiny-csv" }, "added 1 package"),
        event("bash", { command: "npm run check" }, "src/generated/routes.gen.ts is stale. Run `pnpm gen`", 1),
        event("bash", { command: "pnpm run check" }, "src/generated/routes.gen.ts is stale. Run `pnpm gen`", 1),
      ].join("\n"),
    )
    const found = mistakes(task("t09-refunds-http"), steps, [
      { name: "fact:idempotency", passed: false },
      { name: "fact:pnpm", passed: false },
      { name: "suite", passed: false },
    ])
    expect(found.map((item) => item.fact)).toEqual(["pnpm", "routes", "idempotency"])
    expect(found.every((item) => item.repeated)).toBe(true)
  })

  test("a mistake on a fact no earlier task taught is not a repeat", () => {
    const steps = transcript(event("bash", { command: "npm run check" }, "src/generated/routes.gen.ts is stale.", 1))
    expect(mistakes(task("t03-invoice-pdf-route"), steps, [])).toEqual([
      { fact: "routes", how: "the check failed on a stale src/generated/routes.gen.ts", repeated: false, stale: false },
    ])
  })

  test("acting on what is out of date is a mistake of its own, never a repeat", () => {
    const steps = transcript(
      event("bash", { command: "pnpm gen" }, 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "gen" not found\nCommand exited with code 1', 1),
    )
    expect(mistakes(task("t19-refund-lookup"), steps, [{ name: "stale:routes", passed: true }])).toEqual([
      { fact: "routes", how: "ran `pnpm gen`, which the repository no longer has", repeated: false, stale: true },
    ])
    // Missing the correction and acting on the spec PDF's old value are two mistakes: the first a repeat.
    const found = mistakes(task("t18-refund-reminder"), [], [
      { name: "fact:window21", passed: false },
      { name: "stale:window", passed: false },
    ])
    expect(found.map((item) => [item.fact, item.repeated, item.stale])).toEqual([
      ["window21", true, false],
      ["window", false, true],
    ])
    // A `pnpm gen` that ran is no mistake.
    expect(mistakes(task("t09-refunds-http"), transcript(event("bash", { command: "pnpm gen" }, "routes.gen.ts: 3 routes")), [])).toEqual([])
  })

  test("live spend is the reported tokens at the given prices, whatever cost the run reported", () => {
    const step = (input: number, output: number, read: number) =>
      JSON.stringify({ type: "step_finish", part: { cost: 0, tokens: { input, output, reasoning: 0, cache: { read, write: 0 } } } })
    const rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    const run = measure({
      task: task("t01-slugify"),
      stdout: [step(10_000, 1_000, 50_000), step(2_000, 500, 60_000)].join("\n"),
      dir: "/r",
      acceptance: [],
      earlier: new Set(),
      rates,
    })
    expect(run.costUsd).toBeCloseTo((12_000 * 3 + 1_500 * 15 + 110_000 * 0.3) / 1_000_000, 6)
    expect(spend({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, rates)).toBe(3)
    // Without prices, the run's own figure.
    expect(measure({ task: task("t01-slugify"), stdout: step(10, 10, 0), dir: "/r", acceptance: [], earlier: new Set() }).costUsd).toBe(0)
  })

  test("records the line that brought each fact, and an out-of-date fact only from a line without the correction", () => {
    const recall = [
      "<vector_memory_recall>",
      "- [mq3w8e] decision: The refund window is 21 days after capture since 16 November 2026 (finance extended it): REFUND_WINDOW_DAYS in src/refunds.ts. The refund policy PDF still says 14 days and is out of date on this.",
      "- [rtrc1w45jqejn] constraint · Refund policy p.1 §2: Refunds are allowed for at most 14 days after capture, as REFUND_WINDOW_DAYS sets.",
      "</vector_memory_recall>",
    ].join("\n")
    const body = { tools: [{ name: "read" }], messages: [{ role: "user", content: [{ type: "text", text: recall }] }] }
    const run = measure({
      task: task("t18-refund-reminder"),
      requests: [{ body, output: "", sentBytes: 0 }],
      stdout: "",
      dir: "/r",
      acceptance: [],
      earlier: new Set(),
    })
    expect(run.delivered).toEqual(["window21"])
    expect(run.brought.map((item) => [item.fact, item.line.slice(0, 17)])).toEqual([
      ["window21", "- [mq3w8e] decisi"],
      ["window", "- [rtrc1w45jqejn]"],
    ])
  })

  test("sums each week and the running total", () => {
    const row = (taskID: string, week: number, inputTokens: number, success: boolean): TaskMetrics => ({
      task: taskID,
      week,
      requests: 2,
      steps: 1,
      reads: 1,
      rereads: 0,
      inputTokens,
      outputTokens: 1,
      memoryTokens: 0,
      memoryToolTokens: 0,
      memoryCalls: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.01,
      mistakes: success ? [] : [{ fact: "cents", how: "x", repeated: true, stale: false }],
      checks: { passed: success ? 2 : 1, total: 2, failed: success ? [] : ["fact:cents"] },
      success,
      delivered: [],
      brought: [],
    })
    const weeks = weekly([row("a", 1, 100, true), row("b", 1, 50, false), row("c", 2, 10, true)])
    expect(weeks.map((week) => [week.week, week.week_totals.inputTokens, week.cumulative.inputTokens, week.cumulative.repeated, week.cumulative.succeeded])).toEqual([
      [1, 150, 150, 1, 1],
      [2, 10, 160, 1, 2],
    ])
  })
})
