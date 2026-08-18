import { describe, expect, test } from "bun:test"
import { costOfUsage, projectCost, ratesAtContext, ratesFor, type ModelCostSource, type ModelRates } from "./model-pricing"

// Shaped exactly like the engine's provider catalog (Provider.models[id].cost),
// which is what the app holds at runtime via useProviders().all().
const sonnet: ModelRates = { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }
const free: ModelRates = { input: 0, output: 0, cache: { read: 0, write: 0 } }
const tiered: ModelRates = {
  input: 1.25,
  output: 10,
  cache: { read: 0.125, write: 1.5 },
  tiers: [{ input: 2.5, output: 15, cache: { read: 0.25, write: 3 }, tier: { type: "context", size: 200_000 } }],
}

const catalog: ReadonlyMap<string, ModelCostSource> = new Map([
  ["anthropic", { models: { "claude-sonnet-5": { cost: sonnet } } }],
  ["opencode", { models: { "big-pickle": { cost: free } } }],
  ["google", { models: { "gemini-3-pro": { cost: tiered } } }],
])

describe("ratesFor", () => {
  test("reads the model's real rates out of the engine catalog", () => {
    expect(ratesFor(catalog, "anthropic", "claude-sonnet-5")).toEqual(sonnet)
  })

  test("any model the engine knows about is priced — no hand-maintained allowlist", () => {
    // The old substring table had no entry for gpt-5, gemini-3-pro or
    // big-pickle, which are exactly the default models, so every cost read
    // "unknown". Anything in the catalog now prices.
    expect(ratesFor(catalog, "google", "gemini-3-pro")).toBeDefined()
  })

  test("returns undefined for an unpriced or all-zero model rather than reporting $0", () => {
    expect(ratesFor(catalog, "opencode", "big-pickle")).toBeUndefined()
    expect(ratesFor(catalog, "anthropic", "not-a-model")).toBeUndefined()
    expect(ratesFor(catalog, "nope", "claude-sonnet-5")).toBeUndefined()
    expect(ratesFor(undefined, "anthropic", "claude-sonnet-5")).toBeUndefined()
  })
})

describe("ratesAtContext", () => {
  test("uses the base rate below the tier threshold", () => {
    expect(ratesAtContext(tiered, 50_000).input).toBe(1.25)
  })

  test("switches to the long-context rate above it", () => {
    expect(ratesAtContext(tiered, 250_000).input).toBe(2.5)
    expect(ratesAtContext(tiered, 250_000).cache.read).toBe(0.25)
  })

  test("a model with no tiers is unaffected by context size", () => {
    expect(ratesAtContext(sonnet, 900_000)).toEqual(sonnet)
  })
})

describe("costOfUsage", () => {
  test("bills cache reads at the cache rate, not the input rate", () => {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0 }
    // 1M cache-read tokens at $0.30, NOT at the $3.00 input rate. Charging
    // cache reads as input overstated agentic sessions by ~10x.
    expect(costOfUsage(sonnet, usage)).toBeCloseTo(0.3, 6)
  })

  test("bills cache writes at their own premium rate", () => {
    const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 1_000_000 }
    expect(costOfUsage(sonnet, usage)).toBeCloseTo(3.75, 6)
  })

  test("counts reasoning tokens as output", () => {
    const usage = { input: 0, output: 500_000, reasoning: 500_000, cacheRead: 0, cacheWrite: 0 }
    expect(costOfUsage(sonnet, usage)).toBeCloseTo(15, 6)
  })

  test("sums every component at its own rate", () => {
    const usage = { input: 100_000, output: 20_000, reasoning: 0, cacheRead: 400_000, cacheWrite: 50_000 }
    const expected = 0.1 * 3 + 0.02 * 15 + 0.4 * 0.3 + 0.05 * 3.75
    expect(costOfUsage(sonnet, usage)).toBeCloseTo(expected, 6)
  })

  test("returns undefined without rates instead of reporting free", () => {
    expect(costOfUsage(undefined, { input: 1000, output: 1000, reasoning: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined()
  })
})

describe("projectCost", () => {
  test("prices the next turn from the model's real rates", () => {
    const projected = projectCost(sonnet, 10_000, 1_000)
    expect(projected?.inputCost).toBeCloseTo((10_000 / 1_000_000) * 3, 6)
    expect(projected?.outputCost).toBeCloseTo((1_000 / 1_000_000) * 15, 6)
    expect(projected?.totalCost).toBeCloseTo(projected!.inputCost + projected!.outputCost, 6)
  })

  test("applies the long-context tier when the prompt crosses it", () => {
    expect(projectCost(tiered, 250_000, 0)?.inputCost).toBeCloseTo((250_000 / 1_000_000) * 2.5, 6)
  })

  test("assumes a default output length when the caller has no estimate", () => {
    expect(projectCost(sonnet, 4_000)?.assumedOutputTokens).toBeGreaterThan(0)
  })

  test("returns undefined for an unpriced model instead of guessing", () => {
    expect(projectCost(undefined, 4_000)).toBeUndefined()
  })

  test("never produces a negative cost from junk input", () => {
    expect(projectCost(sonnet, -5_000, -1)?.totalCost).toBe(0)
  })
})
