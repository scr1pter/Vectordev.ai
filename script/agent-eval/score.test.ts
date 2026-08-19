import { test, expect } from "bun:test"
import {
  MAX_DISCIPLINE_PENALTY,
  aggregate,
  isIgnoredPath,
  matchesExpected,
  scoreTask,
  type FileDiff,
  type RuntimeId,
  type ScoringSpec,
  type TaskRun,
} from "./score"
import { TASKS, scoringSpec, taskById } from "./tasks"

const spec: ScoringSpec = {
  id: "demo",
  category: "bug-fix",
  expectedFiles: ["src/demo.ts"],
  mutationCount: 0,
}

function ran(overrides: Partial<Extract<TaskRun, { status: "ran" }>> = {}): TaskRun {
  return {
    taskId: "demo",
    runtime: "vector" as RuntimeId,
    status: "ran",
    wallMs: 1_000,
    agentExitCode: 0,
    checkExitCode: 0,
    diff: [{ path: "src/demo.ts", added: 1, removed: 1 }],
    protectedViolations: [],
    assertionFailures: [],
    mutationsCaught: 0,
    ...overrides,
  }
}

test("a green check with a clean diff scores full marks", () => {
  const score = scoreTask(spec, ran())
  expect(score.outcome).toBe("pass")
  expect(score.score).toBe(100)
  expect(score.filesTouched).toBe(1)
  expect(score.linesTouched).toBe(2)
  expect(score.outOfScopeFiles).toEqual([])
})

test("a non-zero objective check is a fail worth zero", () => {
  const score = scoreTask(spec, ran({ checkExitCode: 1 }))
  expect(score.outcome).toBe("fail")
  expect(score.score).toBe(0)
})

test("editing a protected file fails the run even when the check is green", () => {
  const score = scoreTask(spec, ran({ protectedViolations: ["test/demo.test.ts"] }))
  expect(score.outcome).toBe("fail")
  expect(score.score).toBe(0)
  expect(score.protectedViolations).toEqual(["test/demo.test.ts"])
})

test("a failed content assertion fails the run even when the check is green", () => {
  const score = scoreTask(spec, ran({ assertionFailures: ["src/demo.ts still contains computeTotal"] }))
  expect(score.outcome).toBe("fail")
  expect(score.score).toBe(0)
})

test("an agent that crashed but still left a green tree passes", () => {
  // The objective check is the arbiter, not the agent's own exit code: a CLI
  // that exits 1 on a harmless warning must not be recorded as a failure.
  expect(scoreTask(spec, ran({ agentExitCode: 1 })).outcome).toBe("pass")
})

test("out-of-scope edits cost discipline points proportional to file and line count", () => {
  const diff: FileDiff[] = [
    { path: "src/demo.ts", added: 2, removed: 2 },
    { path: "README.md", added: 4, removed: 2 },
  ]
  const score = scoreTask(spec, ran({ diff }))
  expect(score.outcome).toBe("pass")
  expect(score.outOfScopeFiles).toEqual(["README.md"])
  expect(score.outOfScopeLines).toBe(6)
  expect(score.disciplinePenalty).toBe(13.5)
  expect(score.score).toBe(86.5)
})

test("the discipline penalty is capped so a sprawling pass still beats a fail", () => {
  const diff = Array.from({ length: 12 }, (_, index) => ({ path: `other/${index}.ts`, added: 30, removed: 30 }))
  const score = scoreTask(spec, ran({ diff }))
  expect(score.disciplinePenalty).toBe(MAX_DISCIPLINE_PENALTY)
  expect(score.score).toBe(100 - MAX_DISCIPLINE_PENALTY)
  expect(score.score).toBeGreaterThan(0)
})

test("agent scratch state and lockfiles are not counted as diff surface", () => {
  const diff: FileDiff[] = [
    { path: "src/demo.ts", added: 1, removed: 1 },
    { path: ".claude/settings.local.json", added: 9, removed: 0 },
    { path: "node_modules/left-pad/index.js", added: 40, removed: 0 },
    { path: "bun.lock", added: 120, removed: 0 },
    { path: ".DS_Store", added: 1, removed: 0 },
  ]
  const score = scoreTask(spec, ran({ diff }))
  expect(score.filesTouched).toBe(1)
  expect(score.outOfScopeFiles).toEqual([])
  expect(score.score).toBe(100)
})

test("build output is deliberately still counted against discipline", () => {
  const score = scoreTask(spec, ran({ diff: [{ path: "dist/demo.js", added: 10, removed: 0 }] }))
  expect(score.outOfScopeFiles).toEqual(["dist/demo.js"])
})

test("mutation coverage scales the score of a test-writing task", () => {
  const testing: ScoringSpec = { id: "t", category: "test-writing", expectedFiles: ["test/**"], mutationCount: 4 }
  const diff: FileDiff[] = [{ path: "test/duration.test.ts", added: 20, removed: 0 }]
  expect(scoreTask(testing, ran({ diff, mutationsCaught: 4 })).score).toBe(100)
  expect(scoreTask(testing, ran({ diff, mutationsCaught: 2 })).score).toBe(50)
  expect(scoreTask(testing, ran({ diff, mutationsCaught: 0 })).score).toBe(0)
  expect(scoreTask(testing, ran({ diff, mutationsCaught: 0 })).outcome).toBe("pass")
})

test("mutations caught are clamped to the number the task actually seeded", () => {
  const testing: ScoringSpec = { id: "t", category: "test-writing", expectedFiles: ["test/**"], mutationCount: 2 }
  const score = scoreTask(
    testing,
    ran({ diff: [{ path: "test/a.test.ts", added: 5, removed: 0 }], mutationsCaught: 9 }),
  )
  expect(score.mutationScore).toBe(1)
  expect(score.score).toBe(100)
})

test("a task that seeds no mutations is not penalised for catching none", () => {
  expect(scoreTask(spec, ran({ mutationsCaught: 0 })).mutationScore).toBe(1)
})

test("an unavailable runtime is recorded, not scored", () => {
  const score = scoreTask(spec, {
    taskId: "demo",
    runtime: "codex",
    status: "unavailable",
    detail: "codex is not installed",
  })
  expect(score.outcome).toBe("unavailable")
  expect(score.score).toBe(0)
  expect(score.detail).toBe("codex is not installed")
})

test("a harness error is distinguishable from an agent failure", () => {
  const score = scoreTask(spec, { taskId: "demo", runtime: "vector", status: "harness-error", detail: "git missing" })
  expect(score.outcome).toBe("error")
})

test("expected-file matching supports exact paths and directory globs", () => {
  expect(matchesExpected("src/demo.ts", ["src/demo.ts"])).toBe(true)
  expect(matchesExpected("src/other.ts", ["src/demo.ts"])).toBe(false)
  expect(matchesExpected("test/a/b.test.ts", ["test/**"])).toBe(true)
  expect(matchesExpected("tests/a.test.ts", ["test/**"])).toBe(false)
  expect(matchesExpected("src/nested/deep.ts", ["src/"])).toBe(true)
})

test("ignored paths are matched on any segment, not just the prefix", () => {
  expect(isIgnoredPath("packages/app/node_modules/x/index.js")).toBe(true)
  expect(isIgnoredPath(".git/config")).toBe(true)
  expect(isIgnoredPath("src/gitignore-helper.ts")).toBe(false)
  expect(isIgnoredPath("bun.lock")).toBe(true)
})

test("aggregates count only measured tasks", () => {
  const scores = [
    scoreTask(spec, ran()),
    scoreTask(spec, ran({ checkExitCode: 1 })),
    scoreTask(spec, { taskId: "demo", runtime: "vector", status: "unavailable", detail: "no cli" }),
    scoreTask(spec, { taskId: "demo", runtime: "vector", status: "harness-error", detail: "git missing" }),
  ]
  const summary = aggregate("vector", scores)
  expect(summary.measured).toBe(2)
  expect(summary.passed).toBe(1)
  expect(summary.failed).toBe(1)
  expect(summary.unavailable).toBe(1)
  expect(summary.errored).toBe(1)
  expect(summary.passRate).toBe(0.5)
  expect(summary.meanScore).toBe(50)
})

test("a runtime that could not be measured at all reports undefined, never zero", () => {
  const scores = TASKS.map((task) =>
    scoreTask(scoringSpec(task), {
      taskId: task.id,
      runtime: "cursor",
      status: "unavailable",
      detail: "cursor-agent is not installed",
    }),
  )
  const summary = aggregate("cursor", scores)
  expect(summary.measured).toBe(0)
  expect(summary.unavailable).toBe(TASKS.length)
  expect(summary.passRate).toBeUndefined()
  expect(summary.meanScore).toBeUndefined()
  expect(summary.totalWallMs).toBe(0)
})

test("wall time, cost and tokens sum over measured tasks only", () => {
  const scores = [
    scoreTask(spec, ran({ wallMs: 4_000, costUsd: 0.02, tokens: 1_200 })),
    scoreTask(spec, ran({ wallMs: 6_000, costUsd: 0.03, tokens: 800, checkExitCode: 1 })),
    scoreTask(spec, { taskId: "demo", runtime: "vector", status: "unavailable", detail: "no cli" }),
  ]
  const summary = aggregate("vector", scores)
  expect(summary.totalWallMs).toBe(10_000)
  expect(summary.totalCostUsd).toBe(0.05)
  expect(summary.totalTokens).toBe(2_000)
})

test("cost and tokens stay undefined when the runtime never reported them", () => {
  const summary = aggregate("vector", [scoreTask(spec, ran())])
  expect(summary.totalCostUsd).toBeUndefined()
  expect(summary.totalTokens).toBeUndefined()
})

test("the real task set scores against its own declared expectations", () => {
  const task = taskById("test-writing-parse-duration")!
  const real = scoringSpec(task)
  expect(real.mutationCount).toBe(task.mutations.length)
  expect(real.expectedFiles).toEqual(["test/**"])

  const score = scoreTask(real, {
    taskId: task.id,
    runtime: "vector",
    status: "ran",
    wallMs: 30_000,
    agentExitCode: 0,
    checkExitCode: 0,
    diff: [
      { path: "test/duration.test.ts", added: 24, removed: 0 },
      { path: "src/duration.ts", added: 2, removed: 2 },
    ],
    protectedViolations: ["src/duration.ts"],
    assertionFailures: [],
    mutationsCaught: 4,
    costUsd: 0.11,
  })
  // Rewriting the implementation under test is the classic way to fake a green
  // test-writing task, so it has to fail no matter how many mutations died.
  expect(score.outcome).toBe("fail")
  expect(score.score).toBe(0)
  expect(score.outOfScopeFiles).toEqual(["src/duration.ts"])
})

test("every task declares a protected file so a green check cannot be faked", () => {
  expect(TASKS.every((task) => task.protectedFiles.length > 0)).toBe(true)
  expect(TASKS.every((task) => task.expectedFiles.length > 0)).toBe(true)
  expect(new Set(TASKS.map((task) => task.id)).size).toBe(TASKS.length)
})
