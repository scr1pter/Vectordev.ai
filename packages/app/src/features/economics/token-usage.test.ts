import { describe, expect, test } from "bun:test"
import { measureUsage } from "./token-usage"
import { addUsage, emptyUsage, totalTokens } from "./economics-types"

describe("measureUsage", () => {
  test("sums real provider-reported usage and cost across assistant messages", () => {
    const measured = measureUsage([
      { role: "user" },
      {
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
        cost: 0.012,
        tokens: { input: 1_000, output: 200, reasoning: 50, cache: { read: 400, write: 100 } },
      },
      {
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-5",
        cost: 0.008,
        tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ])

    expect(measured).toBeDefined()
    expect(measured!.usage).toEqual({ input: 1_500, output: 300, reasoning: 50, cacheRead: 400, cacheWrite: 100 })
    expect(measured!.costUsd).toBeCloseTo(0.02, 10)
    expect(measured!.messageCount).toBe(2)
    expect(measured!.model).toBe("claude-sonnet-5")
  })

  test("returns undefined when nothing reported usage, rather than a zero that reads as free", () => {
    expect(measureUsage([{ role: "user" }])).toBeUndefined()
    expect(measureUsage([])).toBeUndefined()
    expect(
      measureUsage([{ role: "assistant", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }]),
    ).toBeUndefined()
  })

  test("ignores non-finite counts instead of poisoning the total with NaN", () => {
    const measured = measureUsage([
      { role: "assistant", cost: Number.NaN, tokens: { input: 100, output: Number.POSITIVE_INFINITY } },
    ])
    expect(measured!.usage.input).toBe(100)
    expect(measured!.usage.output).toBe(0)
    expect(measured!.costUsd).toBe(0)
  })

  test("reports the most recent model when a session switches mid-run", () => {
    const measured = measureUsage([
      { role: "assistant", modelID: "gpt-4o-mini", tokens: { input: 10, output: 5 } },
      { role: "assistant", modelID: "claude-opus-5", tokens: { input: 20, output: 5 } },
    ])
    expect(measured!.model).toBe("claude-opus-5")
  })
})

describe("usage arithmetic", () => {
  test("totalTokens counts every metered token, cache reads and writes included", () => {
    // Cache writes are separately metered and billed at a premium, so omitting
    // them understated how much work a run did.
    expect(totalTokens({ input: 100, output: 50, reasoning: 10, cacheRead: 40, cacheWrite: 999 })).toBe(1199)
  })

  test("addUsage is additive across every field", () => {
    const sum = addUsage(
      { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      { input: 10, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50 },
    )
    expect(sum).toEqual({ input: 11, output: 22, reasoning: 33, cacheRead: 44, cacheWrite: 55 })
    expect(addUsage(emptyUsage, emptyUsage)).toEqual(emptyUsage)
  })
})
