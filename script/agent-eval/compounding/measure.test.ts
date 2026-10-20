import { describe, expect, test } from "bun:test"
import { junit, mistakes, transcript, weekly, type TaskMetrics } from "./measure"
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
      { fact: "routes", how: "the check failed on a stale src/generated/routes.gen.ts", repeated: false },
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
      mistakes: success ? [] : [{ fact: "cents", how: "x", repeated: true }],
      checks: { passed: success ? 2 : 1, total: 2, failed: success ? [] : ["fact:cents"] },
      success,
      delivered: [],
    })
    const weeks = weekly([row("a", 1, 100, true), row("b", 1, 50, false), row("c", 2, 10, true)])
    expect(weeks.map((week) => [week.week, week.week_totals.inputTokens, week.cumulative.inputTokens, week.cumulative.repeated, week.cumulative.succeeded])).toEqual([
      [1, 150, 150, 1, 1],
      [2, 10, 160, 1, 2],
    ])
  })
})
