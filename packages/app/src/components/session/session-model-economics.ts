import {
  completedOutcome,
  outcomeCostCoverage,
  outcomeLatencyCoverage,
  outcomeModelKey,
  outcomeQualityScore,
  type ModelOutcome,
} from "@/features/economics/economics-types"
import { projectCost, ratesFor, type ModelCostSource } from "@/features/economics/model-pricing"

// Orders recorded history for one task category using the recommender's quality score:
// checks adjusted for execution reliability first; compare cost only within fully priced quality ties.
//
// Two different cost numbers matter here and they are not interchangeable.
// `medianCostUsd` is what runs on this model HAVE cost — the provider's own
// reported spend, carried on each outcome and computed by the engine. That is
// the honest measure, so it leads. `projectedCostUsd` is what one more turn at
// the current context size WOULD cost, priced from the engine's live rate
// catalog; it is the only way to say anything about cost before a model has
// been run, and it is explicitly labelled as an estimate in the UI.
export function rankModelsForCategory(
  outcomes: ModelOutcome[],
  category: ModelOutcome["category"],
  promptTokens: number,
  providers: ReadonlyMap<string, ModelCostSource> | undefined,
) {
  const matching = outcomes.filter((outcome) => outcome.category === category)
  const groups = new Map<string, ModelOutcome[]>()
  for (const outcome of matching) {
    const key = outcomeModelKey(outcome)
    const list = groups.get(key) ?? []
    list.push(outcome)
    groups.set(key, list)
  }
  const ranked = [...groups.values()].map((list) => {
    const checked = list.filter((outcome) => outcome.hadChecks && outcome.checksPassed !== undefined)
    const checkPassRate = checked.length
      ? checked.filter((outcome) => outcome.checksPassed === true).length / checked.length
      : undefined
    return {
      key: outcomeModelKey(list[0]),
      provider: list[0].provider,
      model: list[0].model,
      mixedModels: list[0].mixedModels,
      variant: list[0].variant,
      sampleSize: list.length,
      completedSamples: list.filter(completedOutcome).length,
      unsuccessfulSamples: list.filter(
        (outcome) => outcome.execution !== undefined && outcome.execution !== "completed",
      ).length,
      checkPassRate,
      qualityScore: outcomeQualityScore(list),
      ...outcomeLatencyCoverage(list),
      ...outcomeCostCoverage(list),
      projectedCostUsd:
        list[0].provider && list[0].model && !list[0].mixedModels
          ? projectCost(ratesFor(providers, list[0].provider, list[0].model), promptTokens)?.totalCost
          : undefined,
    }
  })
  const uncertain = new Set(
    ranked.filter((row) => row.unknownCostSamples > 0 || row.pricedSamples < 3).map((row) => row.qualityScore),
  )
  // One policy for an entire quality/price tie keeps sorting transitive with mixed timing coverage.
  const uncertainTiming = new Set(
    ranked
      .filter((row) => row.unknownLatencySamples > 0 || row.timedSamples < 3)
      .map((row) => JSON.stringify([row.qualityScore, row.medianCostUsd])),
  )
  return ranked.sort((a, b) => {
    const passDiff = b.qualityScore - a.qualityScore
    if (passDiff !== 0) return passDiff
    if (uncertain.has(a.qualityScore)) return a.key.localeCompare(b.key)
    const costDiff = a.medianCostUsd! - b.medianCostUsd!
    if (costDiff !== 0) return costDiff
    if (uncertainTiming.has(JSON.stringify([a.qualityScore, a.medianCostUsd]))) return a.key.localeCompare(b.key)
    return a.medianLatencyMs! - b.medianLatencyMs! || a.key.localeCompare(b.key)
  })
}
