import type { ModelOutcome } from "@/features/economics/economics-types"
import { projectCost, ratesFor, type ModelCostSource } from "@/features/economics/model-pricing"

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// Ranks recorded outcomes for one task category exactly like the recommender:
// check-pass rate first, then measured cost, then median latency.
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
    const key = `${outcome.provider}::${outcome.model}`
    const list = groups.get(key) ?? []
    list.push(outcome)
    groups.set(key, list)
  }
  return [...groups.values()]
    .map((list) => {
      const checked = list.filter((outcome) => outcome.hadChecks && outcome.checksPassed !== undefined)
      const checkPassRate = checked.length
        ? checked.filter((outcome) => outcome.checksPassed === true).length / checked.length
        : undefined
      // Absent rather than zero: a run whose provider reported no spend must
      // not read as free next to one that reported real spend. The engine
      // reports 0 both for a genuinely free model and for one missing from the
      // rate catalog, and those are indistinguishable here — so a zero is
      // dropped and the row falls back to "cost unknown" rather than claiming
      // a paid model is free.
      const measured = list
        .map((outcome) => outcome.costUsd)
        .filter((cost): cost is number => typeof cost === "number" && cost > 0)
      return {
        provider: list[0].provider,
        model: list[0].model,
        sampleSize: list.length,
        checkPassRate,
        medianLatencyMs: medianOf(list.map((outcome) => outcome.latencyMs)),
        medianCostUsd: measured.length ? medianOf(measured) : undefined,
        projectedCostUsd: projectCost(ratesFor(providers, list[0].provider, list[0].model), promptTokens)?.totalCost,
      }
    })
    .sort((a, b) => {
      const passDiff = (b.checkPassRate ?? -1) - (a.checkPassRate ?? -1)
      if (passDiff !== 0) return passDiff
      const aCost = a.medianCostUsd ?? Infinity
      const bCost = b.medianCostUsd ?? Infinity
      if (aCost !== bCost) return aCost - bCost
      return a.medianLatencyMs - b.medianLatencyMs
    })
}
