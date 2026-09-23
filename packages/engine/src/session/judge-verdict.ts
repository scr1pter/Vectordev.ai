// The judge subagent (src/agent/prompt/judge.txt) ends its report with a
// compact block whose first line is `VERDICT: PASS | FAIL | INCONCLUSIVE`
// followed by `SCORES: requirement N/4, ...`. This is the one place that
// grammar is parsed, so anything that wants to read a verdict — the GitHub PR
// evidence bundle, a future desktop badge — agrees on what counts as one.

export type JudgeVerdict = "PASS" | "FAIL" | "INCONCLUSIVE"

const VERDICT = /^[ \t]*\**VERDICT:?\**[ \t]*:?[ \t]*\**(PASS|FAIL|INCONCLUSIVE)\b/gim
const SCORES = /^[ \t]*\**SCORES:?\**[ \t]*:?[ \t]*\**[ \t]*(.+?)\**[ \t]*$/gim

/**
 * Returns the last verdict line found in `text`, or undefined when the text
 * carries none. The last one wins because the judge may quote the expected
 * format before writing its own answer.
 */
export function parseJudgeVerdict(text: string | null | undefined): JudgeVerdict | undefined {
  if (!text) return undefined
  let found: JudgeVerdict | undefined
  for (const match of text.matchAll(VERDICT)) {
    found = match[1].toUpperCase() as JudgeVerdict
  }
  return found
}

/**
 * Returns the body of the last `SCORES:` line (e.g. `requirement 4/4,
 * correctness 3/4, ...`), or undefined when the judge wrote none. Same
 * last-one-wins rule as the verdict, for the same reason.
 */
export function parseJudgeScores(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  let found: string | undefined
  for (const match of text.matchAll(SCORES)) {
    const body = match[1].trim()
    if (body) found = body
  }
  return found
}
