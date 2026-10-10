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
    execution: "completed",
    variant: { kind: "named", name: "low" },
    changedFiles: 1,
    latencyKind: "assistant-reply-sum",
    ...input,
  } satisfies ModelOutcome
}

describe("context model economics ranking", () => {
  test("an equal quality/price tier uses one identity order for all timing coverage permutations", () => {
    const models = ["a", "b", "c"].map((model) =>
      Array.from({ length: 3 }, () =>
        outcome({
          model,
          costUsd: 1,
          latencyMs: model === "a" ? 300 : model === "c" ? 10 : 0,
          latencyKind: model === "b" ? undefined : "assistant-reply-sum",
        }),
      ),
    )
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      const rows = rankModelsForCategory(
        order.flatMap((index) => models[index]),
        "frontend",
        0,
        undefined,
      )
      expect(rows.map((row) => row.model)).toEqual(["a", "b", "c"])
      expect(rows.find((row) => row.model === "b")).toMatchObject({ timedSamples: 0, unknownLatencySamples: 3 })
      expect(rows.find((row) => row.model === "b")?.medianLatencyMs).toBeUndefined()
    }
  })

  test("fully observed reply times order exact price ties; unknown timing does not hide cheaper cost", () => {
    const runs = (model: string, costUsd: number, latencyMs?: number) =>
      Array.from({ length: 3 }, () => outcome({ model, costUsd, latencyMs }))
    expect(rankModelsForCategory([...runs("a", 1, 100), ...runs("b", 1, 10)], "frontend", 0, undefined)[0]?.model).toBe(
      "b",
    )
    expect(rankModelsForCategory([...runs("a", 1, 100), ...runs("b", 0.5)], "frontend", 0, undefined)[0]?.model).toBe(
      "b",
    )
  })

  test("mixed and unknown model history preserves totals without single-model price projections", () => {
    const rows = rankModelsForCategory(
      [
        outcome({
          provider: undefined,
          model: undefined,
          mixedModels: true,
          costUsd: 0.3,
          latencyMs: 200,
          variant: undefined,
        }),
        outcome({ provider: undefined, model: undefined, costUsd: undefined, latencyMs: 300, variant: undefined }),
      ],
      "frontend",
      100,
      new Map([["provider", { models: { m: { cost: { input: 1, output: 2, cache: { read: 0.1, write: 1 } } } } }]]),
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.mixedModels)).toMatchObject({
      sampleSize: 1,
      medianCostUsd: 0.3,
      pricedSamples: 1,
      medianLatencyMs: 200,
    })
    expect(rows.find((row) => !row.mixedModels)).toMatchObject({
      sampleSize: 1,
      unknownCostSamples: 1,
      medianLatencyMs: 300,
    })
    expect(rows.every((row) => row.projectedCostUsd === undefined)).toBe(true)
  })

  test("keeps named, mixed and unknown effort histories separate with honest cost coverage", () => {
    const ranked = rankModelsForCategory(
      [
        outcome({ model: "m", variant: { kind: "named", name: "low" }, costUsd: 0.1, latencyMs: 100 }),
        outcome({ model: "m", variant: { kind: "named", name: "low" }, costUsd: undefined, latencyMs: 100 }),
        outcome({ model: "m", variant: { kind: "named", name: "low" }, costUsd: undefined, latencyMs: 100 }),
        outcome({ model: "m", variant: { kind: "named", name: "max" }, costUsd: 3, latencyMs: 100 }),
        outcome({ model: "m", variant: { kind: "mixed" }, execution: "failed", costUsd: 4, latencyMs: 100 }),
        outcome({ model: "m", variant: undefined, costUsd: 5, latencyMs: 100 }),
      ],
      "frontend",
      0,
      undefined,
    )
    expect(ranked).toHaveLength(4)
    expect(ranked.find((row) => row.variant?.kind === "named" && row.variant.name === "low")).toMatchObject({
      sampleSize: 3,
      pricedSamples: 1,
      unknownCostSamples: 2,
      medianCostUsd: 0.1,
    })
    expect(ranked.find((row) => row.variant?.kind === "mixed")).toMatchObject({
      sampleSize: 1,
      medianCostUsd: 4,
      unsuccessfulSamples: 1,
    })
    expect(ranked.find((row) => row.variant === undefined)).toMatchObject({ sampleSize: 1, medianCostUsd: 5 })
  })

  test("keeps unsuccessful work in history and lowers reliability without inventing failed checks", () => {
    const reliable = Array.from({ length: 3 }, () => outcome({ model: "reliable", costUsd: 1, latencyMs: 100 }))
    const unstable = Array.from({ length: 3 }, () => outcome({ model: "unstable", costUsd: 0.1, latencyMs: 10 }))
    const failed = outcome({ model: "unstable", execution: "failed", costUsd: 0.01, latencyMs: 1 })
    const ranked = rankModelsForCategory([...unstable, failed, ...reliable], "frontend", 0, undefined)
    expect(ranked[0]?.model).toBe("reliable")
    expect(ranked[1]).toMatchObject({ sampleSize: 4, completedSamples: 3, unsuccessfulSamples: 1, qualityScore: 0.375 })
    expect(ranked[1]?.checkPassRate).toBeUndefined()
  })

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
