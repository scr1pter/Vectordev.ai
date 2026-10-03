import { expect, test } from "bun:test"
import { cacheReadShare, meterLine, totalTokens, type Meter } from "./meter"

const meter = (lines: unknown[]) =>
  lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).reduce<Meter>(meterLine, {})

test("Vector's steps add up, subagents' included, with reasoning counted as output", () => {
  const step = (cost: number, subagent?: true) => ({
    type: "step_finish",
    ...(subagent ? { subagent } : {}),
    part: {
      type: "step-finish",
      cost,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1_000, write: 200 } },
    },
  })
  const result = meter([step(0.01), "not json", step(0.02, true)])
  expect(result.costUsd).toBeCloseTo(0.03)
  expect(result.requests).toBe(2)
  expect(result.tokens).toEqual({ input: 200, cacheRead: 2_000, cacheWrite: 400, output: 50, reasoning: 10 })
})

test("Claude Code's totals cover every model its run used", () => {
  const result = meter([
    {
      type: "result",
      total_cost_usd: 0.42,
      num_turns: 7,
      usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 900 },
      modelUsage: {
        "claude-sonnet-4-5": {
          inputTokens: 10,
          outputTokens: 300,
          cacheReadInputTokens: 5_000,
          cacheCreationInputTokens: 900,
        },
        "claude-haiku-4-5": {
          inputTokens: 40,
          outputTokens: 60,
          cacheReadInputTokens: 2_000,
          cacheCreationInputTokens: 100,
        },
      },
    },
  ])
  expect(result.costUsd).toBe(0.42)
  expect(result.requests).toBe(7)
  expect(result.tokens).toEqual({ input: 50, cacheRead: 7_000, cacheWrite: 1_000, output: 360, reasoning: 0 })
})

test("Codex's cached input is taken out of its input, whichever event format it uses", () => {
  const usage = { input_tokens: 3_000, cached_input_tokens: 2_000, output_tokens: 400, reasoning_output_tokens: 150 }
  const expected = { input: 1_000, cacheRead: 2_000, cacheWrite: 0, output: 400, reasoning: 150 }
  expect(meter([{ type: "turn.completed", usage }]).tokens).toEqual(expected)
  expect(
    meter([
      { type: "turn.completed", usage },
      { type: "turn.completed", usage },
    ]).tokens?.input,
  ).toBe(2_000)
  // The older token_count events are cumulative, so only the last one counts.
  const older = (input: number) => ({
    msg: { type: "token_count", info: { total_token_usage: { ...usage, input_tokens: input } } },
  })
  expect(meter([older(2_500), older(3_000)]).tokens).toEqual(expected)
  // Codex reports no price, and an unknown cost stays unknown rather than zero.
  expect(meter([{ type: "turn.completed", usage }]).costUsd).toBeUndefined()
})

test("totals and the cache-read share", () => {
  const tokens = { input: 100, cacheRead: 800, cacheWrite: 100, output: 50, reasoning: 10 }
  expect(totalTokens(tokens)).toBe(1_050)
  expect(cacheReadShare(tokens)).toBe(0.8)
  expect(cacheReadShare({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 })).toBeUndefined()
})
