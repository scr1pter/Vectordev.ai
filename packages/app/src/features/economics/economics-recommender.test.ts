import { describe, expect, test } from "bun:test"
import { recommendModel } from "./economics-recommender"
import type { ModelOutcome } from "./economics-types"

let idCounter = 0
function outcome(partial: Partial<ModelOutcome> & Pick<ModelOutcome, "provider" | "model">): ModelOutcome {
  idCounter += 1
  return {
    id: `outcome-${idCounter}`,
    projectId: "proj-1",
    category: "frontend",
    createdAt: Date.now(),
    hadChecks: false,
    latencyMs: 1000,
    changedFiles: 1,
    ...partial,
  }
}

describe("recommendModel", () => {
  test("cold start returns undefined when no model has enough samples", () => {
    const outcomes = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
    ]
    expect(recommendModel(outcomes, "frontend", 3)).toBeUndefined()
  })

  test("returns undefined on completely empty history", () => {
    expect(recommendModel([], "frontend")).toBeUndefined()
  })

  test("ignores outcomes from other task categories", () => {
    const outcomes = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", category: "backend" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", category: "backend" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", category: "backend" }),
    ]
    expect(recommendModel(outcomes, "frontend", 3)).toBeUndefined()
  })

  test("ranks by tournament win rate first", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: false }),
      outcome({ provider: "openai", model: "gpt-4o", tournamentWin: true }),
      outcome({ provider: "openai", model: "gpt-4o", tournamentWin: false }),
      outcome({ provider: "openai", model: "gpt-4o", tournamentWin: false }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.provider).toBe("anthropic")
    expect(result?.model).toBe("claude-sonnet-5")
    expect(result?.winRate).toBeCloseTo(2 / 3, 6)
    expect(result?.sampleSize).toBe(3)
  })

  test("falls back to check pass rate when win rate is tied or absent", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: false }),
      outcome({ provider: "openai", model: "gpt-4o", hadChecks: true, checksPassed: true }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.model).toBe("claude-sonnet-5")
    expect(result?.checkPassRate).toBeCloseTo(2 / 3, 6)
  })

  test("falls back to median latency when win rate and check pass rate are both absent", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", latencyMs: 4000 }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", latencyMs: 4200 }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", latencyMs: 3800 }),
      outcome({ provider: "openai", model: "gpt-4o", latencyMs: 1000 }),
      outcome({ provider: "openai", model: "gpt-4o", latencyMs: 1200 }),
      outcome({ provider: "openai", model: "gpt-4o", latencyMs: 900 }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.model).toBe("gpt-4o")
    expect(result?.medianLatencyMs).toBe(1000)
  })

  test("evidence strings describe wins and check pass rate in the expected format", () => {
    const outcomes: ModelOutcome[] = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: true, hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: true, hadChecks: true, checksPassed: true }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: false, hadChecks: true, checksPassed: false }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5", tournamentWin: true, hadChecks: true, checksPassed: true }),
    ]
    const result = recommendModel(outcomes, "frontend", 3)
    expect(result?.evidence).toContain("won 3 of 4 recent frontend tournaments")
    expect(result?.evidence).toContain("checks passed 3/4 runs")
  })

  test("minSamples is configurable", () => {
    const outcomes = [
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
      outcome({ provider: "anthropic", model: "claude-sonnet-5" }),
    ]
    expect(recommendModel(outcomes, "frontend", 3)).toBeUndefined()
    expect(recommendModel(outcomes, "frontend", 2)?.model).toBe("claude-sonnet-5")
  })
})

describe("recommendModel cost ranking", () => {
  const usage = { input: 1_000, output: 200, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  const runs = (provider: string, model: string, costUsd: number) =>
    [0, 1, 2].map(() => outcome({ provider, model, costUsd, usage, latencyMs: 1_000 }))

  test("prefers the cheaper model when correctness and latency tie", () => {
    const result = recommendModel([...runs("openai", "gpt-4o", 0.05), ...runs("openai", "gpt-4o-mini", 0.002)], "frontend", 3)
    expect(result?.model).toBe("gpt-4o-mini")
    expect(result?.medianCostUsd).toBeCloseTo(0.002, 10)
    expect(result?.medianTokens).toBe(1_200)
  })

  test("correctness still outranks cost — an expensive model that passes checks beats a cheap one that fails", () => {
    const cheapFailing = [0, 1, 2].map(() =>
      outcome({ provider: "openai", model: "cheap", costUsd: 0.001, usage, hadChecks: true, checksPassed: false }),
    )
    const pricyPassing = [0, 1, 2].map(() =>
      outcome({ provider: "anthropic", model: "pricy", costUsd: 0.5, usage, hadChecks: true, checksPassed: true }),
    )
    expect(recommendModel([...cheapFailing, ...pricyPassing], "frontend", 3)?.model).toBe("pricy")
  })

  test("a model with unmeasured spend never sorts ahead of one that reported cost", () => {
    const unmeasured = [0, 1, 2].map(() => outcome({ provider: "x", model: "unmeasured", latencyMs: 1_000 }))
    const measured = [0, 1, 2].map(() => outcome({ provider: "y", model: "measured", costUsd: 9.99, usage, latencyMs: 1_000 }))
    expect(recommendModel([...unmeasured, ...measured], "frontend", 3)?.model).toBe("measured")
  })

  test("omits cost fields entirely when no run reported usage", () => {
    const result = recommendModel([0, 1, 2].map(() => outcome({ provider: "x", model: "m" })), "frontend", 3)
    expect(result?.medianCostUsd).toBeUndefined()
    expect(result?.medianTokens).toBeUndefined()
    expect(result?.evidence.some((line) => line.includes("tokens at $"))).toBe(false)
  })

  test("surfaces measured spend as evidence", () => {
    const result = recommendModel(runs("openai", "gpt-4o", 0.0125), "frontend", 3)
    expect(result?.evidence.some((line) => line.includes("median 1,200 tokens at $0.0125 per run"))).toBe(true)
  })
})
