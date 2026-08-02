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

// One verified data point: a single model run against a single task category,
// scoped to a project. `checksPassed` is only meaningful when `hadChecks` is
// true — a run with no validation checks configured has no pass/fail signal.
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
  evidence: string[]
}
