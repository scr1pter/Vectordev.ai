// Scores a review against the defects planted in an evaluation fixture (script/vectorscope-eval). Pure, so a recorded
// run can be re-scored with another slack without another model call.

export interface EvalExpectation {
  id: string
  path: string
  line: number // a head line the diff added
  endLine?: number
  severity: "blocking" | "concern"
  category?: string
  description: string
}

export interface ReviewScore {
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
  matches: { expected: string; finding: number }[] // finding is an index into the input findings
}

export const DEFAULT_SLACK = 3

// A finding matches an expectation when the paths agree and its line range overlaps the expected range widened by
// `slack` lines on both sides. Matching is one-to-one, closest pairs first, so a second finding about the same defect
// counts as a false positive. Nits are not claims of a defect and are left out unless `countNits`.
export function scoreReview(input: {
  expected: EvalExpectation[]
  findings: { path: string; line: number; endLine?: number; severity: string; title: string }[]
  slack?: number
  countNits?: boolean
}): ReviewScore {
  const slack = input.slack ?? DEFAULT_SLACK
  const counted = input.findings.flatMap((finding, index) =>
    input.countNits || finding.severity !== "nit" ? [{ index, path: cleanPath(finding.path), ...span(finding) }] : [],
  )
  const pairs = input.expected
    .flatMap((expected, which) => {
      const path = cleanPath(expected.path)
      const target = span(expected)
      return counted
        .filter((finding) => finding.path === path)
        .filter((finding) => finding.start <= target.end + slack && finding.end >= target.start - slack)
        .map((finding) => ({
          which,
          index: finding.index,
          gap: Math.max(0, target.start - finding.end, finding.start - target.end),
          offset: Math.abs(finding.start - target.start),
        }))
    })
    .toSorted((a, b) => a.gap - b.gap || a.offset - b.offset || a.which - b.which || a.index - b.index)
  const usedExpected = new Set<number>()
  const usedFindings = new Set<number>()
  const matched = pairs.filter((pair) => {
    if (usedExpected.has(pair.which) || usedFindings.has(pair.index)) return false
    usedExpected.add(pair.which)
    usedFindings.add(pair.index)
    return true
  })
  return {
    ...rates(matched.length, counted.length - matched.length, input.expected.length - matched.length),
    matches: matched
      .toSorted((a, b) => a.which - b.which)
      .map((pair) => ({ expected: input.expected[pair.which].id, finding: pair.index })),
  }
}

// Micro-averaged over every fixture run: the counts are summed before the rates are taken, so a fixture with three
// findings weighs more than one with none.
export function totalScores(scores: ReviewScore[]): Omit<ReviewScore, "matches"> {
  return rates(
    scores.reduce((sum, score) => sum + score.truePositives, 0),
    scores.reduce((sum, score) => sum + score.falsePositives, 0),
    scores.reduce((sum, score) => sum + score.falseNegatives, 0),
  )
}

// No findings is a precise review and nothing to find is a complete one, so each rate is 1 when its denominator is 0.
function rates(truePositives: number, falsePositives: number, falseNegatives: number) {
  const precision = truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives)
  const recall = truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives)
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  }
}

function span(range: { line: number; endLine?: number }) {
  return { start: range.line, end: Math.max(range.line, range.endLine ?? range.line) }
}

function cleanPath(path: string) {
  return path.trim().replace(/^(\.\/|\/)+/, "")
}
