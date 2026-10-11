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
  expect(result.costComplete).toBe(true)
  expect(result.costSource).toBe("catalog-estimate")
  expect(result.tokensComplete).toBe(true)
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
  expect(result.costSource).toBe("runtime-reported")
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
  expect(meter([{ type: "turn.completed", usage }]).costSource).toBe("unknown")
})

test("totals and the cache-read share", () => {
  const tokens = { input: 100, cacheRead: 800, cacheWrite: 100, output: 50, reasoning: 10 }
  expect(totalTokens(tokens)).toBe(1_050)
  expect(cacheReadShare(tokens)).toBe(0.8)
  expect(cacheReadShare({ input: 0, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0 })).toBeUndefined()
})

test("an unpriced Vector step keeps the whole run cost unknown after later priced steps", () => {
  const step = (part: Record<string, unknown>) => ({
    type: "step_finish",
    part: { tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, ...part },
  })
  const result = meter([step({ cost: 0.02 }), step({ cost: 0, unpriced: true }), step({ cost: 0.03 })])
  expect(result.costUsd).toBeUndefined()
  expect(result.costComplete).toBe(false)
  expect(result.costSource).toBe("unknown")
  expect(result.knownCostUsd).toBeCloseTo(0.05)
  expect(result.requests).toBe(3)
  expect(result.tokens?.input).toBe(300)
})

test("missing and invalid step prices never turn into a measured free run", () => {
  const lines = [
    '{"type":"step_finish","part":{}}',
    '{"type":"step_finish","part":{"cost":null}}',
    '{"type":"step_finish","part":{"cost":"0.01"}}',
    '{"type":"step_finish","part":{"cost":-1}}',
    '{"type":"step_finish","part":{"cost":1e400}}',
  ]
  for (const line of lines) {
    const result = meter([line, { type: "step_finish", part: { cost: 0.01 } }])
    expect(result.costUsd).toBeUndefined()
    expect(result.costComplete).toBe(false)
    expect(result.knownCostUsd).toBeCloseTo(0.01)
  }
})

test("finite zero pricing remains measured and large sums cannot overflow to infinite spend", () => {
  const free = meter([{ type: "step_finish", part: { cost: 0 } }])
  expect(free.costUsd).toBe(0)
  expect(free.costComplete).toBe(true)
  const overflow = meter([
    { type: "step_finish", part: { cost: 1e308 } },
    { type: "step_finish", part: { cost: 1e308 } },
  ])
  expect(overflow.costUsd).toBeUndefined()
  expect(overflow.costComplete).toBe(false)
  expect(overflow.knownCostUsd).toBeUndefined()
})

test("missing terminal-result prices invalidate earlier estimates rather than preserving a stale total", () => {
  const result = meter([
    { type: "result", total_cost_usd: 0.42 },
    { type: "result", total_cost_usd: -1 },
  ])
  expect(result.costUsd).toBeUndefined()
  expect(result.costComplete).toBe(false)
  expect(result.costSource).toBe("unknown")
  expect(result.knownCostUsd).toBe(0.42)
})

test("leading whitespace and malformed JSON cannot corrupt metering", () => {
  const result = meter(['  {"type":"step_finish","part":{"cost":0.01}}  ', '{"type":"step_finish",'])
  expect(result.costUsd).toBe(0.01)
  expect(result.requests).toBe(1)
})

test("negative and impossible token subdivisions cannot inflate totals", () => {
  const result = meter([
    {
      type: "turn.completed",
      usage: { input_tokens: 10, cached_input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 50 },
    },
  ])
  expect(result.tokens).toEqual({ input: 0, cacheRead: 10, cacheWrite: 0, output: 5, reasoning: 5 })
  expect(totalTokens(result.tokens!)).toBe(15)
  expect(meter([{ type: "step_finish", part: { cost: 0, tokens: { input: -10, output: 0 } } }]).tokens).toBeUndefined()
})

test("a missing Vector request usage invalidates earlier and later counts without affecting known pricing", () => {
  const valid = { type: "step_finish", part: { cost: 0.01, tokens: { input: 100, output: 20 } } }
  const result = meter([valid, { type: "step_finish", part: { cost: 0.01 } }, valid])
  expect(result.tokens).toBeUndefined()
  expect(result.tokensComplete).toBe(false)
  expect(result.requests).toBe(3)
  expect(result.costUsd).toBeCloseTo(0.03)
})

test("required Vector token counts cannot be missing, negative, fractional, nonfinite or strings", () => {
  const valid = { type: "step_finish", part: { cost: 0.01, tokens: { input: 100, output: 20 } } }
  for (const invalid of [undefined, null, -1, 0.5, Infinity, "10"]) {
    for (const field of ["input", "output"]) {
      const tokens = { input: 100, output: 20, [field]: invalid }
      const result = meter([valid, { type: "step_finish", part: { cost: 0.01, tokens } }, valid])
      expect(result.tokens).toBeUndefined()
      expect(result.tokensComplete).toBe(false)
    }
  }
  expect(meter(['{"type":"step_finish","part":{"tokens":{"input":1e400,"output":10}}}']).tokens).toBeUndefined()
})

test("optional reasoning and cache fields may be absent while valid zero usage remains measured", () => {
  const result = meter([{ type: "step_finish", part: { cost: 0, tokens: { input: 0, output: 0 } } }])
  expect(result.tokens).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
  expect(result.tokensComplete).toBe(true)
  expect(meter([{ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }]).tokens).toEqual({
    input: 100,
    cacheRead: 0,
    cacheWrite: 0,
    output: 20,
    reasoning: 0,
  })
})

test("missing Codex turn usage invalidates the complete run rather than preserving a partial subtotal", () => {
  const valid = { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }
  for (const invalid of [{ type: "turn.completed" }, { type: "turn.completed", usage: { input_tokens: 100 } }]) {
    const result = meter([valid, invalid, valid])
    expect(result.tokens).toBeUndefined()
    expect(result.tokensComplete).toBe(false)
  }
})

test("an invalid Claude subagent usage cannot be hidden by valid main-model usage", () => {
  const result = meter([
    {
      type: "result",
      total_cost_usd: 0.01,
      usage: { input_tokens: 100, output_tokens: 20 },
      modelUsage: {
        main: { inputTokens: 100, outputTokens: 20 },
        subagent: { inputTokens: 50 },
      },
    },
  ])
  expect(result.tokens).toBeUndefined()
  expect(result.tokensComplete).toBe(false)
  expect(result.costUsd).toBe(0.01)
  expect(
    meter([{ type: "result", modelUsage: { main: { inputTokens: 100, outputTokens: 20 }, subagent: null } }]).tokens,
  ).toBeUndefined()
})

test("a terminal result with no usage invalidates earlier cumulative counts", () => {
  const result = meter([
    { type: "result", usage: { input_tokens: 100, output_tokens: 20 } },
    { type: "result" },
    { type: "result", usage: { input_tokens: 200, output_tokens: 40 } },
  ])
  expect(result.tokens).toBeUndefined()
  expect(result.tokensComplete).toBe(false)
})
