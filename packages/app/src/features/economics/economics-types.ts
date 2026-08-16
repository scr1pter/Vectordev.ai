// Shared types for the Model Economics Engine — Vector is BYOK-native, so it
// learns which model performs best per task category from *verified* outcomes
// (real parallel workspace runs, real validation checks), never from guesses.

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

// Billable total. Cache reads are counted because providers charge for them
// (at a discount folded into the reported cost), while cache writes are
// already billed as input by every provider Vector supports.
export function totalTokens(usage: TokenUsage) {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead
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

// One verified data point: a single model run against a single task category,
// scoped to a project. `checksPassed` is only meaningful when `hadChecks` is
// true — a run with no validation checks configured has no pass/fail signal.
// `usage` and `costUsd` are the provider's own reported numbers, so they are
// absent rather than zero when a run produced no measurable usage.
export type ModelOutcome = {
  id: string
  projectId: string
  provider: string
  model: string
  category: TaskCategory
  createdAt: number
  checksPassed?: boolean
  hadChecks: boolean
  latencyMs: number
  changedFiles: number
  tournamentWin?: boolean
  usage?: TokenUsage
  costUsd?: number
}

// A recommendation is only ever produced from real ModelOutcome history —
// `winRate` and `checkPassRate` are omitted (not zeroed) when there is no
// tournament or check data to compute them from.
export type ModelRecommendation = {
  provider: string
  model: string
  sampleSize: number
  winRate?: number
  checkPassRate?: number
  medianLatencyMs: number
  // Omitted when no run in the group reported usage — a model with unknown
  // spend must not appear cheaper than one that honestly reported its cost.
  medianCostUsd?: number
  medianTokens?: number
  evidence: string[]
}
