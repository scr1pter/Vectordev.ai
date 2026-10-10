// Shared types for the Model Economics Engine — Vector is BYOK-native, so it
// learns from observed execution, validation and spend. Completion alone is not proof that checks passed.

export type TaskCategory =
  | "documentation"
  | "bug-fix"
  | "small-edit"
  | "frontend"
  | "backend"
  | "refactor"
  | "architecture"
  | "testing"
  | "general"

// Measured token counts for a run, summed from the provider's own reported
// usage on each assistant message. These are never estimated from character
// counts — an outcome either carries real usage or carries none at all.
export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export const emptyUsage: TokenUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

// Missing evidence is unknown, including historical provider defaults. Names are exact observed presets,
// not interchangeable UI labels or a claim about every effective provider option.
export type VariantEvidence = { kind: "named"; name: string } | { kind: "mixed" }

// A complete sum of the main session's assistant intervals, including work/waits inside those intervals.
// This excludes gaps, startup and separate child/title intervals; it is not provider latency or task wall time.
export type MeasuredLatency = { latencyMs: number; latencyKind: "assistant-reply-sum" }

// Every token the run put through the provider. Cache reads and writes are
// both counted: each is separately metered and separately billed (reads at a
// discount, writes at a premium), so leaving either out understates how much
// work the run actually did. This is a token count, not a cost — spend comes
// from the provider's own reported figure on the outcome, or from the engine's
// rate catalog via costOfUsage.
export function totalTokens(usage: TokenUsage) {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

// One cumulative task outcome, scoped to a project. Identity is absent for mixed or unknown model history.
// `checksPassed` is only meaningful when `hadChecks` is
// true — a run with no validation checks configured has no pass/fail signal.
// `usage` and `costUsd` are the provider's own reported numbers, so they are
// absent rather than zero when a run produced no measurable usage.
export type ModelOutcome = {
  id: string
  projectId: string
  provider?: string
  model?: string
  // Preserve cumulative history without assigning several observed models' work to a single one.
  mixedModels?: boolean
  variant?: VariantEvidence
  category: TaskCategory
  createdAt: number
  checksPassed?: boolean
  hadChecks: boolean
  // Execution completion is distinct from passing validation. Older records have unknown execution status.
  execution?: "completed" | "failed" | "aborted" | "incomplete"
  latencyMs?: number
  // Legacy numeric durations mixed partial reply sums with workspace age. Their origin is unknown.
  latencyKind?: MeasuredLatency["latencyKind"]
  changedFiles: number
  usage?: TokenUsage
  costUsd?: number
  // Set when every response of the run had a listed price, so a costUsd of 0 is a free run. Outcomes recorded before
  // Vector marked unpriced responses lack it, and their 0 cannot be told apart from an unknown price.
  costPriced?: boolean
}

// What a run is known to have cost, for ranking: a 0 counts only when the run was fully priced, so a model with no
// listed price never ranks as free next to one that reported real spend.
export function knownCostUsd(outcome: Pick<ModelOutcome, "costUsd" | "costPriced">) {
  const cost = outcome.costUsd
  if (outcome.costPriced === false) return undefined
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined
  if (cost === 0 && outcome.costPriced !== true) return undefined
  return cost
}

export function outcomeModelKey(outcome: Pick<ModelOutcome, "provider" | "model" | "mixedModels" | "variant">) {
  return JSON.stringify([
    outcome.provider,
    outcome.model,
    outcome.mixedModels === true,
    outcome.variant?.kind ?? "unknown",
    outcome.variant?.kind === "named" ? outcome.variant.name : null,
  ])
}

export function outcomeCostCoverage(outcomes: readonly Pick<ModelOutcome, "costUsd" | "costPriced">[]) {
  const costs = outcomes
    .map(knownCostUsd)
    .filter((cost): cost is number => cost !== undefined)
    .sort((a, b) => a - b)
  const mid = Math.floor(costs.length / 2)
  return {
    pricedSamples: costs.length,
    unknownCostSamples: outcomes.length - costs.length,
    medianCostUsd: !costs.length ? undefined : costs.length % 2 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2,
  }
}

export function outcomeLatencyCoverage(outcomes: readonly Pick<ModelOutcome, "latencyMs" | "latencyKind">[]) {
  const times = outcomes
    .filter((outcome) => outcome.latencyKind === "assistant-reply-sum")
    .map((outcome) => outcome.latencyMs)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time) && time >= 0)
    .sort((a, b) => a - b)
  const mid = Math.floor(times.length / 2)
  return {
    timedSamples: times.length,
    unknownLatencySamples: outcomes.length - times.length,
    medianLatencyMs: !times.length
      ? undefined
      : times.length % 2
        ? times[mid]
        : times[mid - 1] + (times[mid] - times[mid - 1]) / 2,
  }
}

// How strongly a model's checked runs back it, for ranking. With no checked runs it sits at an even 0.5, so a model
// that was never checked does not rank below one that failed every check; checked runs pull the score toward their
// pass rate, more firmly the more of them there are. Unlike a raw rate that is undefined without checks, this orders
// every model consistently, which a sort comparator needs.
export function checkPassScore(outcomes: readonly Pick<ModelOutcome, "hadChecks" | "checksPassed">[]) {
  const checked = outcomes.filter((outcome) => outcome.hadChecks && outcome.checksPassed !== undefined)
  return (checked.filter((outcome) => outcome.checksPassed === true).length + 1) / (checked.length + 2)
}

// A known unsuccessful execution cannot qualify merely because an earlier validation report passed.
export function completedOutcome(outcome: Pick<ModelOutcome, "execution" | "hadChecks" | "checksPassed">) {
  if (outcome.execution !== undefined) return outcome.execution === "completed"
  return outcome.hadChecks && outcome.checksPassed === true
}

// Retain unsuccessful work in quality evidence without inventing failed validation checks. Unknown legacy
// execution cannot count as completion or dilute the observed failure fraction.
export function outcomeQualityScore(
  outcomes: readonly Pick<ModelOutcome, "execution" | "hadChecks" | "checksPassed">[],
) {
  const completed = outcomes.filter(completedOutcome).length
  const unsuccessful = outcomes.filter(
    (outcome) => outcome.execution !== undefined && outcome.execution !== "completed",
  ).length
  const reliability = completed + unsuccessful ? completed / (completed + unsuccessful) : 1
  // Earlier passing checks cannot reward a failed attempt. Actual failed checks remain negative evidence.
  return (
    checkPassScore(outcomes.filter((outcome) => outcome.checksPassed !== true || completedOutcome(outcome))) * reliability
  )
}

// A recommendation is only ever produced from real ModelOutcome history.
// `checkPassRate`, `medianCostUsd`, and `medianTokens` are omitted rather than
// zeroed when there is no data, so an unmeasured model never reads as free or
// as failing.
export type ModelRecommendation = {
  provider: string
  model: string
  variant: string
  sampleSize: number
  completedSamples: number
  pricedSamples: number
  unknownCostSamples: number
  checkPassRate?: number
  medianLatencyMs?: number
  timedSamples: number
  unknownLatencySamples: number
  // Omitted when no run in the group reported usage — a model with unknown
  // spend must not appear cheaper than one that honestly reported its cost.
  medianCostUsd?: number
  medianTokens?: number
  evidence: string[]
}
