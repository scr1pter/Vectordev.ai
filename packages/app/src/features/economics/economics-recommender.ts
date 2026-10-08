import {
  checkPassScore,
  knownCostUsd,
  knownLatencyMs,
  totalTokens,
  type ModelOutcome,
  type ModelRecommendation,
  type TaskCategory,
} from "./economics-types"

type Group = {
  provider: string
  model: string
  outcomes: ModelOutcome[]
}

function groupKey(provider: string, model: string) {
  return `${provider}::${model}`
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// undefined when no outcome in this group ran validation checks.
function checkPassRateOf(outcomes: ModelOutcome[]): number | undefined {
  const checked = outcomes.filter((o) => o.hadChecks && o.checksPassed !== undefined)
  if (checked.length === 0) return undefined
  return checked.filter((o) => o.checksPassed === true).length / checked.length
}

// undefined when no run in the group reported spend. A model that never
// reported cost must not sort ahead of one that did just because its absent
// cost reads as cheaper.
function medianCostOf(outcomes: ModelOutcome[]): number | undefined {
  const costs = outcomes.map(knownCostUsd).filter((cost): cost is number => cost !== undefined)
  if (costs.length === 0) return undefined
  return median(costs)
}

function medianTokensOf(outcomes: ModelOutcome[]): number | undefined {
  const counts = outcomes
    .map((o) => o.usage)
    .filter((usage) => usage !== undefined)
    .map(totalTokens)
  if (counts.length === 0) return undefined
  return median(counts)
}

function evidenceFor(provider: string, model: string, category: TaskCategory, outcomes: ModelOutcome[]): string[] {
  const evidence: string[] = []

  const checked = outcomes.filter((o) => o.hadChecks && o.checksPassed !== undefined)
  if (checked.length > 0) {
    const passed = checked.filter((o) => o.checksPassed === true).length
    evidence.push(`checks passed ${passed}/${checked.length} runs`)
  }
  if (checked.length === 0) evidence.push("No validation checks recorded")

  const cost = medianCostOf(outcomes)
  const tokens = medianTokensOf(outcomes)
  if (cost !== undefined && tokens !== undefined) {
    const price = cost > 0 && cost < 0.0001 ? "<$0.0001" : `$${cost.toFixed(4)}`
    evidence.push(`median ${Math.round(tokens).toLocaleString()} tokens at ${price} per run`)
  }
  if (cost === undefined) evidence.push("Cost unknown: no fully priced runs recorded")

  evidence.push(
    `${outcomes.length} recorded ${category} run${outcomes.length === 1 ? "" : "s"} for ${provider}/${model}`,
  )
  return evidence
}

// Ranks models by verified outcomes for a task category: check pass rate
// first, then measured cost, then median latency (lower is better). Below
// minSamples for every model, returns undefined — cold start is honest: no
// recommendation without enough evidence, never a guess dressed up as one.
export function recommendModel(
  outcomes: ModelOutcome[],
  category: TaskCategory,
  minSamples = 3,
  available?: (provider: string, model: string) => boolean,
): ModelRecommendation | undefined {
  const matching = outcomes.filter((o) => o.category === category && (!available || available(o.provider, o.model)))

  const groups = new Map<string, Group>()
  for (const outcome of matching) {
    const key = groupKey(outcome.provider, outcome.model)
    const group = groups.get(key) ?? { provider: outcome.provider, model: outcome.model, outcomes: [] }
    group.outcomes.push(outcome)
    groups.set(key, group)
  }

  const eligible = [...groups.values()].filter((group) => group.outcomes.length >= minSamples)
  if (eligible.length === 0) return undefined

  const ranked = eligible
    .map((group) => {
      const timings = group.outcomes.map(knownLatencyMs).filter((latency): latency is number => latency !== undefined)
      return {
        group,
        checkPassRate: checkPassRateOf(group.outcomes),
        checkPassScore: checkPassScore(group.outcomes),
        medianLatencyMs: timings.length ? median(timings) : undefined,
        medianCostUsd: medianCostOf(group.outcomes),
        medianTokens: medianTokensOf(group.outcomes),
      }
    })
    .sort((a, b) => {
      const passDiff = b.checkPassScore - a.checkPassScore
      if (passDiff !== 0) return passDiff
      // Cheaper wins once correctness ties. Unknown spend sorts last rather
      // than first, so an unmeasured model never masquerades as free. Both
      // unknown compares equal and falls through to latency — subtracting the
      // two sentinels would yield NaN and corrupt the sort.
      const aCost = a.medianCostUsd ?? Infinity
      const bCost = b.medianCostUsd ?? Infinity
      if (aCost !== bCost) return aCost - bCost
      const aLatency = a.medianLatencyMs ?? Infinity
      const bLatency = b.medianLatencyMs ?? Infinity
      return aLatency === bLatency ? 0 : aLatency - bLatency
    })

  const best = ranked[0]
  return {
    provider: best.group.provider,
    model: best.group.model,
    sampleSize: best.group.outcomes.length,
    checkPassRate: best.checkPassRate,
    medianLatencyMs: best.medianLatencyMs,
    medianCostUsd: best.medianCostUsd,
    medianTokens: best.medianTokens,
    evidence: evidenceFor(best.group.provider, best.group.model, category, best.group.outcomes),
  }
}
