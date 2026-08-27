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
})
