// Pure scoring for the agent eval harness. Nothing in this file touches the
// disk, the network, or a process: a run recorded once can be re-scored later
// with different weights without spending another model call. run.ts owns
// everything that observes the world and hands the observations in here.

export type RuntimeId = "vector" | "claude-code" | "codex" | "cursor"

export const RUNTIME_IDS = ["vector", "claude-code", "codex", "cursor"] as const satisfies readonly RuntimeId[]

export type TaskCategory = "bug-fix" | "feature" | "refactor" | "test-writing"

export type FileDiff = { path: string; added: number; removed: number }

// The scoring-relevant half of a task definition. tasks.ts carries the fixture
// and the prompt too; score.ts only ever needs these four fields.
export type ScoringSpec = {
  id: string
  category: TaskCategory
  // Relative paths the task expects the agent to edit. An entry ending in "/**"
  // or "/" matches everything below that directory; anything else is exact.
  expectedFiles: string[]
  // How many seeded mutations the task's own check is supposed to catch. Zero
  // for every task that is not measuring test quality.
  mutationCount: number
}

export type TaskRun = { taskId: string; runtime: RuntimeId } &
  // The runtime's CLI is missing, or it answered with an authentication
  // failure. There is no measurement here, so it is never scored as a zero.
  (| { status: "unavailable"; detail: string }
    // The harness itself could not produce a measurement (fixture creation
    // failed, git or the check command is missing). Also never scored as a zero,
    // because it says nothing about the agent.
    | { status: "harness-error"; detail: string }
    | {
        status: "ran"
        wallMs: number
        agentExitCode: number
        checkExitCode: number
        diff: FileDiff[]
        // Files the task declared immutable (usually the tests that define
        // success) that the agent changed anyway.
        protectedViolations: string[]
        // Content assertions the task declared that the final tree does not
        // satisfy, e.g. an old symbol still present after a rename.
        assertionFailures: string[]
        mutationsCaught: number
        costUsd?: number
        tokens?: number
      }
  )

export type TaskOutcome = "pass" | "fail" | "unavailable" | "error"

export type TaskScore = {
  taskId: string
  runtime: RuntimeId
  category: TaskCategory
  outcome: TaskOutcome
  detail?: string
  filesTouched: number
  linesTouched: number
  outOfScopeFiles: string[]
  outOfScopeLines: number
  protectedViolations: string[]
  assertionFailures: string[]
  disciplinePenalty: number
  mutationScore: number
  wallMs?: number
  costUsd?: number
  tokens?: number
  score: number
}

export type RuntimeAggregate = {
  runtime: RuntimeId
  // Tasks that produced a real measurement — the denominator for passRate and
  // meanScore. Unavailable and errored tasks are deliberately not in it.
  measured: number
  passed: number
  failed: number
  unavailable: number
  errored: number
  passRate?: number
  meanScore?: number
  totalWallMs: number
  totalOutOfScopeFiles: number
  totalCostUsd?: number
  totalTokens?: number
}

// Paths an agent may legitimately create as a side effect of working, which say
// nothing about how surgical its edit was. Kept deliberately short: build
// output and stray scratch files are NOT here, because producing them in a
// fixture this small is itself a discipline signal.
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", ".claude", ".codex", ".cursor", ".opencode", ".vector"])
const IGNORED_FILES = new Set(["bun.lock", "bun.lockb", ".DS_Store"])

export const OUT_OF_SCOPE_FILE_PENALTY = 12
export const OUT_OF_SCOPE_LINE_PENALTY = 0.25
export const MAX_DISCIPLINE_PENALTY = 45

export function isIgnoredPath(path: string) {
  const segments = path.split("/")
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return true
  return IGNORED_FILES.has(segments.at(-1) ?? "")
}

export function matchesExpected(path: string, patterns: string[]) {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2))
    if (pattern.endsWith("/")) return path.startsWith(pattern)
    return path === pattern
  })
}

export function scoreTask(spec: ScoringSpec, run: TaskRun): TaskScore {
  const identity = { taskId: run.taskId, runtime: run.runtime, category: spec.category }
  const empty = {
    filesTouched: 0,
    linesTouched: 0,
    outOfScopeFiles: [],
    outOfScopeLines: 0,
    protectedViolations: [],
    assertionFailures: [],
    disciplinePenalty: 0,
    mutationScore: 0,
    score: 0,
  }
  if (run.status === "unavailable") return { ...identity, ...empty, outcome: "unavailable", detail: run.detail }
  if (run.status === "harness-error") return { ...identity, ...empty, outcome: "error", detail: run.detail }

  const diff = run.diff.filter((file) => !isIgnoredPath(file.path))
  const outOfScope = diff.filter((file) => !matchesExpected(file.path, spec.expectedFiles))
  const outOfScopeLines = outOfScope.reduce((total, file) => total + file.added + file.removed, 0)
  const disciplinePenalty = Math.min(
    MAX_DISCIPLINE_PENALTY,
    round(outOfScope.length * OUT_OF_SCOPE_FILE_PENALTY + outOfScopeLines * OUT_OF_SCOPE_LINE_PENALTY, 1),
  )
  // Mutation coverage only means something once the suite is green, so a task
  // that seeds no mutations scores a neutral 1 rather than dragging every
  // non-test-writing task to zero.
  const mutationScore =
    spec.mutationCount === 0 ? 1 : round(Math.min(run.mutationsCaught, spec.mutationCount) / spec.mutationCount, 4)
  const objective =
    run.checkExitCode === 0 && run.protectedViolations.length === 0 && run.assertionFailures.length === 0

  return {
    ...identity,
    outcome: objective ? "pass" : "fail",
    filesTouched: diff.length,
    linesTouched: diff.reduce((total, file) => total + file.added + file.removed, 0),
    outOfScopeFiles: outOfScope.map((file) => file.path),
    outOfScopeLines,
    protectedViolations: run.protectedViolations,
    assertionFailures: run.assertionFailures,
    disciplinePenalty,
    mutationScore,
    wallMs: run.wallMs,
    costUsd: run.costUsd,
    tokens: run.tokens,
    score: objective ? Math.max(0, round(100 * mutationScore - disciplinePenalty, 1)) : 0,
  }
}

export function aggregate(runtime: RuntimeId, scores: TaskScore[]): RuntimeAggregate {
  const measured = scores.filter((entry) => entry.outcome === "pass" || entry.outcome === "fail")
  const passed = measured.filter((entry) => entry.outcome === "pass")
  const costs = measured.map((entry) => entry.costUsd).filter((value): value is number => typeof value === "number")
  const tokens = measured.map((entry) => entry.tokens).filter((value): value is number => typeof value === "number")
  return {
    runtime,
    measured: measured.length,
    passed: passed.length,
    failed: measured.length - passed.length,
    unavailable: scores.filter((entry) => entry.outcome === "unavailable").length,
    errored: scores.filter((entry) => entry.outcome === "error").length,
    // Undefined rather than 0 when nothing was measured: "we did not find out"
    // and "it failed everything" must never render as the same number.
    passRate: measured.length === 0 ? undefined : round(passed.length / measured.length, 4),
    meanScore:
      measured.length === 0
        ? undefined
        : round(measured.reduce((total, entry) => total + entry.score, 0) / measured.length, 1),
    totalWallMs: measured.reduce((total, entry) => total + (entry.wallMs ?? 0), 0),
    totalOutOfScopeFiles: measured.reduce((total, entry) => total + entry.outOfScopeFiles.length, 0),
    totalCostUsd:
      costs.length === 0
        ? undefined
        : round(
            costs.reduce((total, value) => total + value, 0),
            4,
          ),
    totalTokens: tokens.length === 0 ? undefined : tokens.reduce((total, value) => total + value, 0),
  }
}

function round(value: number, places: number) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
