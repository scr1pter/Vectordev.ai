import { describe, expect, test } from "bun:test"
import { measureUsage } from "./token-usage"
import { addUsage, emptyUsage, totalTokens } from "./economics-types"

describe("measureUsage", () => {
  test("only homogeneous observed preset names qualify; mixed and unknown keep their totals", () => {
    const message = {
      role: "assistant",
      providerID: "p",
      modelID: "m",
      cost: 0.1,
      tokens: { input: 10 },
      variant: "low",
    }
    expect(measureUsage([message, message])?.variant).toEqual({ kind: "named", name: "low" })
    const mixed = measureUsage([message, { ...message, variant: "max" }])
    expect(mixed?.variant).toEqual({ kind: "mixed" })
    expect(mixed?.costUsd).toBeCloseTo(0.2)
    expect(mixed?.usage.input).toBe(20)
    expect(measureUsage([message, { ...message, variant: undefined }])?.variant).toBeUndefined()
    expect(measureUsage([{ ...message, variant: undefined }])?.variant).toBeUndefined()
    expect(measureUsage([message, { ...message, variant: "max", forked: true }])?.variant).toEqual({
      kind: "named",
      name: "low",
    })
  })

  test("an unmetered later attempt cannot qualify another preset's paid history", () => {
    const message = {
      role: "assistant",
      providerID: "p",
      modelID: "m",
      variant: "low",
      cost: 0.1,
      tokens: { input: 10 },
    }
    expect(measureUsage([message, { ...message, variant: "max", tokens: undefined }])?.variant).toEqual({
      kind: "mixed",
    })
    expect(measureUsage([message, { ...message, variant: undefined, tokens: undefined }])?.variant).toBeUndefined()
    expect(
      measureUsage([
        { ...message, variant: "xhigh" },
        { ...message, variant: "max" },
      ])?.variant,
    ).toEqual({ kind: "mixed" })
  })

  test("unmetered cross-model attempts invalidate identity in either order without assuming they were free", () => {
    const paid = {
      role: "assistant",
      providerID: "p",
      modelID: "paid",
      variant: "low",
      cost: 0.1,
      tokens: { input: 10 },
    }
    const unmetered = { role: "assistant", providerID: "p", modelID: "unmetered", variant: "max", cost: 0 }
    for (const messages of [
      [paid, unmetered],
      [unmetered, paid],
    ]) {
      const result = measureUsage(messages)
      expect(result).toMatchObject({ mixedModels: true, usage: { input: 10 }, messageCount: 1 })
      expect(result?.provider).toBeUndefined()
      expect(result?.model).toBeUndefined()
      expect(result?.variant).toBeUndefined()
      expect(result?.costUsd).toBeUndefined()
    }
    const unknown = measureUsage([paid, { ...unmetered, providerID: undefined, modelID: undefined }])
    expect(unknown?.model).toBeUndefined()
    expect(unknown?.mixedModels).toBeUndefined()
    expect(unknown?.costUsd).toBeUndefined()
    expect(measureUsage([paid, { ...unmetered, forked: true }])).toMatchObject({
      provider: "p",
      model: "paid",
      variant: { kind: "named", name: "low" },
      costUsd: 0.1,
    })
  })

  test("a run with an unpriced response has no cost, since the rest of it is not what the run cost", () => {
    const measured = measureUsage([
      {
        role: "assistant",
        providerID: "local",
        modelID: "m",
        cost: 0.01,
        tokens: { input: 1_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        role: "assistant",
        providerID: "local",
        modelID: "m",
        cost: 0,
        unpriced: true,
        tokens: { input: 500, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ])
    expect(measured?.usage.input).toBe(1_500)
    expect(measured?.costUsd).toBeUndefined()
  })

  test("leaves out history a fork copied in, which the original session already measured", () => {
    const measured = measureUsage([
      {
        role: "assistant",
        providerID: "local",
        modelID: "m",
        cost: 0,
        forked: true,
        tokens: { input: 9_000, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        role: "assistant",
        providerID: "local",
        modelID: "m",
        cost: 0.02,
        tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ])
    expect(measured?.usage.input).toBe(1_000)
    expect(measured?.costUsd).toBe(0.02)
    expect(measured?.messageCount).toBe(1)
  })

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
      measureUsage([
        { role: "assistant", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      ]),
    ).toBeUndefined()
  })

  test("ignores non-finite counts instead of poisoning the total with NaN", () => {
    const measured = measureUsage([
      { role: "assistant", cost: Number.NaN, tokens: { input: 100, output: Number.POSITIVE_INFINITY } },
    ])
    expect(measured!.usage.input).toBe(100)
    expect(measured!.usage.output).toBe(0)
    expect(measured!.costUsd).toBeUndefined()
  })

  test("clamps impossible negative provider usage but leaves invalid spend unknown", () => {
    const measured = measureUsage([
      {
        role: "assistant",
        cost: -1,
        tokens: { input: 100, output: -10, reasoning: -20, cache: { read: -30, write: 5 } },
      },
    ])
    expect(measured?.usage).toEqual({ input: 100, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 5 })
    expect(measured?.costUsd).toBeUndefined()
  })

  test("keeps switched-model totals without attributing the whole run to the last model", () => {
    const measured = measureUsage([
      { role: "assistant", modelID: "gpt-4o-mini", tokens: { input: 10, output: 5 } },
      { role: "assistant", modelID: "claude-opus-5", tokens: { input: 20, output: 5 } },
    ])
    expect(measured!.model).toBeUndefined()
    expect(measured!.provider).toBeUndefined()
    expect(measured!.usage.input).toBe(30)
  })

  test("counts a cache-write-only response and its real charge", () => {
    const measured = measureUsage([
      {
        role: "assistant",
        providerID: "anthropic",
        modelID: "sonnet",
        cost: 0.00375,
        tokens: { cache: { write: 1_000 } },
      },
    ])
    expect(measured?.usage.cacheWrite).toBe(1_000)
    expect(measured?.costUsd).toBe(0.00375)
    expect(measured?.messageCount).toBe(1)
  })

  test("a missing charge never becomes a free run or a partial total", () => {
    expect(measureUsage([{ role: "assistant", tokens: { input: 1_000 } }])?.costUsd).toBeUndefined()
    expect(
      measureUsage([
        { role: "assistant", cost: 0.2, tokens: { input: 1_000 } },
        { role: "assistant", tokens: { output: 100 } },
      ])?.costUsd,
    ).toBeUndefined()
  })

  test("includes reported charges even when that response lacks token counters", () => {
    const measured = measureUsage([
      { role: "assistant", providerID: "x", modelID: "m", cost: 0.02, tokens: { input: 1_000 } },
      { role: "assistant", providerID: "x", modelID: "m", cost: 0.03 },
    ])
    expect(measured?.costUsd).toBeCloseTo(0.05, 10)
    expect(measured?.model).toBe("m")
  })

  test("the same model id on different providers is not a single-model sample", () => {
    const measured = measureUsage([
      { role: "assistant", providerID: "openai", modelID: "m", cost: 0.02, tokens: { input: 100 } },
      { role: "assistant", providerID: "openrouter", modelID: "m", cost: 0.03, tokens: { input: 100 } },
    ])
    expect(measured?.costUsd).toBeCloseTo(0.05, 10)
    expect(measured?.model).toBeUndefined()
  })


  test("keeps mixed-model totals without attributing the entire run to its last model", () => {
    const measured = measureUsage([
      { role: "assistant", providerID: "openai", modelID: "gpt-4o-mini", cost: 0.01, tokens: { input: 10, output: 5 } },
      {
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        cost: 0.02,
        tokens: { input: 20, output: 5 },
      },
    ])
    expect(measured?.model).toBeUndefined()
    expect(measured?.provider).toBeUndefined()
    expect(measured?.usage.input).toBe(30)
    expect(measured?.costUsd).toBeCloseTo(0.03)
  })

  test("does not merge identical model names from different providers into one model's evidence", () => {
    const measured = measureUsage([
      { role: "assistant", providerID: "a", modelID: "model", cost: 0.01, tokens: { input: 10 } },
      { role: "assistant", providerID: "b", modelID: "model", cost: 0.02, tokens: { input: 20 } },
    ])
    expect(measured?.model).toBeUndefined()
    expect(measured?.provider).toBeUndefined()
    expect(measured?.messageCount).toBe(2)
  })

  test("a missing price on one measured message leaves the total cost unknown", () => {
    const measured = measureUsage([
      { role: "assistant", cost: 0.01, tokens: { input: 10 } },
      { role: "assistant", tokens: { input: 20 } },
    ])
    expect(measured?.usage.input).toBe(30)
    expect(measured?.costUsd).toBeUndefined()
  })

  test("preserves an explicitly reported zero cost", () => {
    expect(measureUsage([{ role: "assistant", cost: 0, tokens: { input: 10 } }])?.costUsd).toBe(0)
  })

  test("counts cache-write-only responses as measured usage", () => {
    const measured = measureUsage([
      { role: "assistant", providerID: "anthropic", modelID: "model", cost: 0.01, tokens: { cache: { write: 100 } } },
    ])
    expect(measured?.usage.cacheWrite).toBe(100)
    expect(measured?.costUsd).toBe(0.01)
    expect(measured?.messageCount).toBe(1)
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
