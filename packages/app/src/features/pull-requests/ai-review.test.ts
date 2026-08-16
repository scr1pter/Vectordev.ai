import { describe, expect, test } from "bun:test"
import {
  buildReviewPrompt,
  countBySeverity,
  formatReviewComment,
  parseReview,
  splitDiffByFile,
  truncateDiff,
} from "./ai-review"

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-const a = 1
+const a = 2
diff --git a/src/b.ts b/src/b.ts
index 3..4 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-const b = 1
+const b = 2
`

describe("splitDiffByFile", () => {
  test("splits on file boundaries and recovers each path", () => {
    const files = splitDiffByFile(diff)
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(files[0]!.patch.startsWith("diff --git ")).toBe(true)
  })

  test("handles an empty diff", () => {
    expect(splitDiffByFile("")).toEqual([])
  })
})

describe("truncateDiff", () => {
  test("keeps everything when under the cap", () => {
    expect(truncateDiff(diff).omittedFiles).toEqual([])
  })

  test("drops whole files rather than splitting a hunk", () => {
    const result = truncateDiff(diff, 150)
    expect(result.omittedFiles.length).toBeGreaterThan(0)
    // Whatever survived must still be complete file patches.
    for (const file of splitDiffByFile(result.diff)) expect(file.patch).toContain("@@")
  })
})

describe("buildReviewPrompt", () => {
  const base = { title: "Fix thing", body: "", baseRef: "main", headRef: "fix", diff }

  test("includes the diff and demands JSON only", () => {
    const prompt = buildReviewPrompt(base)
    expect(prompt).toContain("src/a.ts")
    expect(prompt).toContain("ONLY a JSON object")
    expect(prompt).toContain("fix into main")
  })

  test("states when files were omitted so a partial review cannot read as a clean pass", () => {
    const prompt = buildReviewPrompt({ ...base, diff: `${diff}${"x".repeat(200_000)}` })
    expect(prompt).toContain("were NOT reviewed")
  })
})

describe("parseReview", () => {
  test("parses a well-formed review", () => {
    const review = parseReview(
      JSON.stringify({
        summary: "Looks reasonable.",
        verdict: "comment",
        findings: [{ file: "src/a.ts", line: 3, severity: "concern", title: "Off by one", detail: "Bounds." }],
      }),
    )
    expect(review?.summary).toBe("Looks reasonable.")
    expect(review?.findings).toHaveLength(1)
    expect(review?.findings[0]!.line).toBe(3)
  })

  test("recovers JSON wrapped in a code fence or prose", () => {
    const payload = '{"summary":"ok","verdict":"approve","findings":[]}'
    expect(parseReview("Here you go:\n```json\n" + payload + "\n```")?.summary).toBe("ok")
    expect(parseReview("Sure! " + payload + " Hope that helps.")?.summary).toBe("ok")
  })

  test("returns undefined for unparseable output", () => {
    expect(parseReview("I could not review this.")).toBeUndefined()
    expect(parseReview("")).toBeUndefined()
    expect(parseReview('{"verdict":"approve"}')).toBeUndefined()
  })

  test("drops findings naming a file outside the diff", () => {
    const review = parseReview(
      JSON.stringify({
        summary: "s",
        verdict: "comment",
        findings: [
          { file: "src/a.ts", severity: "nit", title: "real", detail: "d" },
          { file: "src/ghost.ts", severity: "blocking", title: "hallucinated", detail: "d" },
        ],
      }),
      ["src/a.ts", "src/b.ts"],
    )
    expect(review?.findings.map((finding) => finding.title)).toEqual(["real"])
  })

  test("never approves while holding a blocking finding", () => {
    const review = parseReview(
      JSON.stringify({
        summary: "s",
        verdict: "approve",
        findings: [{ file: "src/a.ts", severity: "blocking", title: "data loss", detail: "d" }],
      }),
    )
    expect(review?.verdict).toBe("request-changes")
  })

  test("only approves when there is genuinely nothing to report", () => {
    expect(parseReview('{"summary":"clean","verdict":"approve","findings":[]}')?.verdict).toBe("approve")
  })

  test("defaults an unknown severity to concern and an unknown verdict to comment", () => {
    const review = parseReview(
      JSON.stringify({
        summary: "s",
        verdict: "lgtm",
        findings: [{ file: "a", severity: "catastrophic", title: "t", detail: "d" }],
      }),
    )
    expect(review?.verdict).toBe("comment")
    expect(review?.findings[0]!.severity).toBe("concern")
  })

  test("discards findings with no title", () => {
    const review = parseReview(
      JSON.stringify({ summary: "s", verdict: "comment", findings: [{ file: "a", severity: "nit", detail: "d" }] }),
    )
    expect(review?.findings).toEqual([])
  })
})

describe("formatReviewComment", () => {
  test("orders blocking findings first and renders suggestions", () => {
    const body = formatReviewComment({
      summary: "Two issues.",
      verdict: "request-changes",
      findings: [
        { file: "b.ts", severity: "nit", title: "naming", detail: "rename" },
        { file: "a.ts", line: 4, severity: "blocking", title: "crash", detail: "null deref", suggestion: "if (x) return" },
      ],
    })
    expect(body.indexOf("crash")).toBeLessThan(body.indexOf("naming"))
    expect(body).toContain("`a.ts:4`")
    expect(body).toContain("```suggestion")
  })

  test("says so plainly when nothing was found", () => {
    const body = formatReviewComment({ summary: "Clean.", verdict: "approve", findings: [] })
    expect(body).toContain("No issues found")
    expect(body).not.toContain("Blocking")
  })
})

describe("countBySeverity", () => {
  test("counts each bucket", () => {
    expect(
      countBySeverity([
        { file: "a", severity: "blocking", title: "t", detail: "d" },
        { file: "b", severity: "nit", title: "t", detail: "d" },
        { file: "c", severity: "nit", title: "t", detail: "d" },
      ]),
    ).toEqual({ blocking: 1, concern: 0, nit: 2 })
  })
})
