import { describe, expect, test } from "bun:test"
import type { ModelOutcome } from "@/features/economics/economics-types"
import { rankModelsForCategory } from "./session-model-economics"

let sequence = 0
function outcome(input: Partial<ModelOutcome> & Pick<ModelOutcome, "model" | "costUsd" | "latencyMs">) {
  sequence += 1
  return {
    id: `outcome-${sequence}`,
    projectId: "/repo",
    provider: "provider",
    category: "frontend",
    createdAt: sequence,
    hadChecks: false,
    changedFiles: 1,
    ...input,
  } satisfies ModelOutcome
}

describe("context model economics ranking", () => {
  test("matches the recommender by preferring measured cost before latency", () => {
    const expensive = [0, 1, 2].map(() => outcome({ model: "fast", costUsd: 1, latencyMs: 100 }))
    const cheaper = [0, 1, 2].map(() => outcome({ model: "cheap", costUsd: 0.1, latencyMs: 1_000 }))

    expect(rankModelsForCategory([...expensive, ...cheaper], "frontend", 0, undefined)[0]?.model).toBe("cheap")
  })

  test("keeps verified correctness ahead of cost", () => {
    const failing = [0, 1, 2].map(() =>
      outcome({ model: "cheap", costUsd: 0.01, latencyMs: 100, hadChecks: true, checksPassed: false }),
    )
    const passing = [0, 1, 2].map(() =>
      outcome({ model: "reliable", costUsd: 1, latencyMs: 1_000, hadChecks: true, checksPassed: true }),
    )

    expect(rankModelsForCategory([...failing, ...passing], "frontend", 0, undefined)[0]?.model).toBe("reliable")
  })

  test("does not quote an empty-context next turn when context has not been measured", () => {
    const runs = [outcome({ model: "model", costUsd: 0.1, latencyMs: 1_000 })]
    const providers = new Map([
      ["provider", { models: { model: { cost: { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } } } } }],
    ])
    const unknown = rankModelsForCategory(runs, "frontend", undefined, providers)[0]
    expect(unknown?.projectedCostUsd).toBeUndefined()
    const estimated = rankModelsForCategory(runs, "frontend", 10_000, providers)[0]
    expect(estimated?.projection?.inputTokens).toBe(10_000)
    expect(estimated?.projection?.assumedOutputTokens).toBe(800)
    expect(estimated?.projectedCostUsd).toBeCloseTo(0.028, 8)
  })

  test("quality and price sample counts distinguish checked evidence from ordinary and unpriced runs", () => {
    const rows = rankModelsForCategory(
      [
        outcome({ model: "model", costUsd: 0.1, latencyMs: 1_000, hadChecks: true, checksPassed: true }),
        outcome({ model: "model", costUsd: undefined, latencyMs: 0, latencyMeasured: false }),
        outcome({ model: "model", costUsd: 0.3, latencyMs: 3_000 }),
      ],
      "frontend",
      undefined,
      undefined,
    )
    expect(rows[0]?.sampleSize).toBe(3)
    expect(rows[0]?.checkedSampleSize).toBe(1)
    expect(rows[0]?.costSampleSize).toBe(2)
    expect(rows[0]?.medianCostUsd).toBe(0.2)
    expect(rows[0]?.medianLatencyMs).toBe(2_000)
  })
})
