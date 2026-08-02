import type { ModelOutcome, ModelRecommendation, TaskCategory } from "./economics-types"

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

// undefined when no outcome in this group has tournament data — never
// fabricate a 0% or 100% win rate from an absence of evidence.
function winRateOf(outcomes: ModelOutcome[]): number | undefined {
  const judged = outcomes.filter((o) => o.tournamentWin !== undefined)
  if (judged.length === 0) return undefined
  return judged.filter((o) => o.tournamentWin === true).length / judged.length
}

// undefined when no outcome in this group ran validation checks.
function checkPassRateOf(outcomes: ModelOutcome[]): number | undefined {
  const checked = outcomes.filter((o) => o.hadChecks && o.checksPassed !== undefined)
  if (checked.length === 0) return undefined
  return checked.filter((o) => o.checksPassed === true).length / checked.length
}

function evidenceFor(provider: string, model: string, category: TaskCategory, outcomes: ModelOutcome[]): string[] {
  const evidence: string[] = []

  const judged = outcomes.filter((o) => o.tournamentWin !== undefined)
  if (judged.length > 0) {
    const wins = judged.filter((o) => o.tournamentWin === true).length
    evidence.push(`won ${wins} of ${judged.length} recent ${category} tournaments`)
  }

  const checked = outcomes.filter((o) => o.hadChecks && o.checksPassed !== undefined)
  if (checked.length > 0) {
    const passed = checked.filter((o) => o.checksPassed === true).length
    evidence.push(`checks passed ${passed}/${checked.length} runs`)
  }

  evidence.push(`${outcomes.length} recorded ${category} run${outcomes.length === 1 ? "" : "s"} for ${provider}/${model}`)
  return evidence
}

// Ranks models by verified outcomes for a task category: tournament win rate
// first, then check pass rate, then median latency (lower is better). Below
// minSamples for every model, returns undefined — cold start is honest: no
// recommendation without enough evidence, never a guess dressed up as one.
export function recommendModel(
  outcomes: ModelOutcome[],
  category: TaskCategory,
  minSamples = 3,
): ModelRecommendation | undefined {
  const matching = outcomes.filter((o) => o.category === category)

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
    .map((group) => ({
      group,
      winRate: winRateOf(group.outcomes),
      checkPassRate: checkPassRateOf(group.outcomes),
      medianLatencyMs: median(group.outcomes.map((o) => o.latencyMs)),
    }))
    .sort((a, b) => {
      const winDiff = (b.winRate ?? -1) - (a.winRate ?? -1)
      if (winDiff !== 0) return winDiff
      const passDiff = (b.checkPassRate ?? -1) - (a.checkPassRate ?? -1)
      if (passDiff !== 0) return passDiff
      return a.medianLatencyMs - b.medianLatencyMs
    })

  const best = ranked[0]
  return {
    provider: best.group.provider,
    model: best.group.model,
    sampleSize: best.group.outcomes.length,
    winRate: best.winRate,
    checkPassRate: best.checkPassRate,
    medianLatencyMs: best.medianLatencyMs,
    evidence: evidenceFor(best.group.provider, best.group.model, category, best.group.outcomes),
  }
}
