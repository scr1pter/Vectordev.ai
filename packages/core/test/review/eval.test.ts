import { describe, expect, test } from "bun:test"
import { scoreReview, totalScores, type EvalExpectation } from "@vectordevai/core/review/eval"

function expectation(overrides: Partial<EvalExpectation> = {}): EvalExpectation {
  return {
    id: "planted",
    path: "src/billing/sync.ts",
    line: 40,
    severity: "blocking",
    description: "The ledger post is not awaited.",
    ...overrides,
  }
}

function finding(overrides: Partial<{ path: string; line: number; endLine: number; severity: string }> = {}) {
  return { path: "src/billing/sync.ts", line: 40, severity: "blocking", title: "Missing await", ...overrides }
}

describe("scoreReview", () => {
  test("an exact match is a true positive", () => {
    const score = scoreReview({ expected: [expectation()], findings: [finding()] })
    expect(score).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      matches: [{ expected: "planted", finding: 0 }],
    })
  })

  test("a finding within the slack window matches and one outside it does not", () => {
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 43 })] }).truePositives).toBe(1)
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 37 })] }).truePositives).toBe(1)
    const outside = scoreReview({ expected: [expectation()], findings: [finding({ line: 44 })] })
    expect(outside).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1, precision: 0, recall: 0 })
    expect(outside.f1).toBe(0)
  })

  test("the slack is configurable", () => {
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 41 })], slack: 0 }).truePositives).toBe(
      0,
    )
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 40 })], slack: 0 }).truePositives).toBe(
      1,
    )
    expect(scoreReview({ expected: [expectation()], findings: [finding({ line: 50 })], slack: 10 }).truePositives).toBe(
      1,
    )
  })

  test("multi-line ranges match when they overlap", () => {
    const planted = expectation({ line: 20, endLine: 30 })
    expect(scoreReview({ expected: [planted], findings: [finding({ line: 25 })] }).truePositives).toBe(1)
    expect(scoreReview({ expected: [planted], findings: [finding({ line: 33 })] }).truePositives).toBe(1)
    expect(scoreReview({ expected: [planted], findings: [finding({ line: 34 })] }).truePositives).toBe(0)
    // A finding that spans the planted line from well before it.
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ line: 10, endLine: 38 })] }).truePositives,
    ).toBe(1)
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ line: 10, endLine: 36 })] }).truePositives,
    ).toBe(0)
  })

  test("an endLine before line is read as the single line", () => {
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ line: 40, endLine: 2 })] }).truePositives,
    ).toBe(1)
  })

  test("matching is one-to-one, closest pair first", () => {
    const duplicate = scoreReview({
      expected: [expectation()],
      findings: [finding({ line: 42 }), finding({ line: 40 })],
    })
    expect(duplicate).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0, precision: 0.5 })
    expect(duplicate.matches).toEqual([{ expected: "planted", finding: 1 }])

    // One finding between two expectations can match only one of them; the second finding takes the other.
    const two = scoreReview({
      expected: [expectation({ id: "a", line: 40 }), expectation({ id: "b", line: 44 })],
      findings: [finding({ line: 43 }), finding({ line: 41 })],
    })
    expect(two).toMatchObject({ truePositives: 2, falsePositives: 0, falseNegatives: 0 })
    expect(two.matches).toEqual([
      { expected: "a", finding: 1 },
      { expected: "b", finding: 0 },
    ])

    const short = scoreReview({
      expected: [expectation({ id: "a", line: 40 }), expectation({ id: "b", line: 42 })],
      findings: [finding({ line: 41 })],
    })
    expect(short).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 1, precision: 1, recall: 0.5 })
    expect(short.f1).toBeCloseTo(2 / 3)
  })

  test("nits are ignored unless counted", () => {
    const findings = [finding({ severity: "nit" }), finding({ path: "src/other.ts", severity: "nit" })]
    expect(scoreReview({ expected: [expectation()], findings })).toMatchObject({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 1,
      precision: 1,
      recall: 0,
      f1: 0,
    })
    const counted = scoreReview({ expected: [expectation()], findings, countNits: true })
    expect(counted).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 0 })
    expect(counted.matches).toEqual([{ expected: "planted", finding: 0 }])
  })

  test("match indexes point into the findings as given, nits included", () => {
    const score = scoreReview({ expected: [expectation()], findings: [finding({ severity: "nit" }), finding()] })
    expect(score.matches).toEqual([{ expected: "planted", finding: 1 }])
  })

  test("a clean fixture with no findings is perfect", () => {
    expect(scoreReview({ expected: [], findings: [] })).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
      matches: [],
    })
  })

  test("findings on a clean fixture are all false alarms", () => {
    const score = scoreReview({ expected: [], findings: [finding(), finding({ severity: "concern" })] })
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 2, falseNegatives: 0, precision: 0, recall: 1 })
    expect(score.f1).toBe(0)
  })

  test("paths match after leading ./ and / are removed", () => {
    for (const path of ["./src/billing/sync.ts", "/src/billing/sync.ts", ".//src/billing/sync.ts"])
      expect(scoreReview({ expected: [expectation()], findings: [finding({ path })] }).truePositives).toBe(1)
    expect(
      scoreReview({ expected: [expectation({ path: "./src/billing/sync.ts" })], findings: [finding()] }).truePositives,
    ).toBe(1)
    expect(
      scoreReview({ expected: [expectation()], findings: [finding({ path: "billing/sync.ts" })] }).truePositives,
    ).toBe(0)
  })

  test("a finding in another file never matches", () => {
    const score = scoreReview({ expected: [expectation()], findings: [finding({ path: "src/billing/types.ts" })] })
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 1 })
  })
})

describe("totalScores", () => {
  test("sums the counts before taking the rates", () => {
    const perfect = scoreReview({ expected: [expectation()], findings: [finding()] })
    const missed = scoreReview({ expected: [expectation()], findings: [] })
    const noisy = scoreReview({ expected: [], findings: [finding(), finding({ line: 90 })] })
    const total = totalScores([perfect, missed, noisy])
    expect(total).toMatchObject({ truePositives: 1, falsePositives: 2, falseNegatives: 1 })
    expect(total.precision).toBeCloseTo(1 / 3)
    expect(total.recall).toBe(0.5)
    expect(total.f1).toBeCloseTo(0.4)
  })

  test("no runs is a perfect, empty total", () => {
    expect(totalScores([])).toEqual({
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 1,
      recall: 1,
      f1: 1,
    })
  })
})
