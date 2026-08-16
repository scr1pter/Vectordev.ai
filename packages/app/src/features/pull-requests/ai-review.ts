// Vector's AI code review: turns a pull request diff into structured findings
// the user can read, edit, and choose to post back to GitHub. Kept pure so the
// prompt, the parsing, and the posted markdown are all testable without a model.

export type ReviewSeverity = "blocking" | "concern" | "nit"

export type ReviewFinding = {
  file: string
  line?: number
  severity: ReviewSeverity
  title: string
  detail: string
  suggestion?: string
}

export type ReviewVerdict = "approve" | "comment" | "request-changes"

export type PullRequestReview = {
  summary: string
  findings: ReviewFinding[]
  verdict: ReviewVerdict
}

// A diff can be far larger than a context window. Truncate on file boundaries
// so the model never sees half a hunk, and say so explicitly in the prompt —
// a review that silently skipped most of the diff would read as a clean bill
// of health.
export function splitDiffByFile(diff: string): { path: string; patch: string }[] {
  const chunks = diff.split(/^diff --git /m).filter((chunk) => chunk.trim())
  return chunks.map((chunk) => {
    const header = chunk.split("\n", 1)[0] ?? ""
    const path = header.match(/b\/(.+)$/)?.[1] ?? header.trim()
    return { path, patch: `diff --git ${chunk}` }
  })
}

export function truncateDiff(diff: string, maxChars = 120_000) {
  if (diff.length <= maxChars) return { diff, omittedFiles: [] as string[] }
  const files = splitDiffByFile(diff)
  const kept: string[] = []
  const omitted: string[] = []
  let size = 0
  for (const file of files) {
    if (size + file.patch.length > maxChars) {
      omitted.push(file.path)
      continue
    }
    kept.push(file.patch)
    size += file.patch.length
  }
  return { diff: kept.join(""), omittedFiles: omitted }
}

export function buildReviewPrompt(input: {
  title: string
  body: string
  baseRef: string
  headRef: string
  diff: string
}) {
  const { diff, omittedFiles } = truncateDiff(input.diff)
  return [
    "You are reviewing a GitHub pull request. Report only real defects you can point at in this diff.",
    "",
    `Title: ${input.title}`,
    `Branch: ${input.headRef} into ${input.baseRef}`,
    input.body ? `Description:\n${input.body}` : "",
    omittedFiles.length
      ? `\nNOTE: ${omittedFiles.length} file(s) were too large to include and were NOT reviewed: ${omittedFiles.join(", ")}. Say so in your summary.`
      : "",
    "",
    "Rules:",
    "- Only report problems visible in the diff. Never speculate about code you cannot see.",
    "- Every finding must name a real file from the diff and, where possible, a line number.",
    "- Prefer correctness, security, and data-loss issues over style.",
    "- If the change is sound, say so and return no findings rather than inventing nits.",
    "",
    "Respond with ONLY a JSON object, no prose around it, in this exact shape:",
    '{"summary":"...","verdict":"approve|comment|request-changes","findings":[{"file":"path","line":12,"severity":"blocking|concern|nit","title":"...","detail":"...","suggestion":"optional replacement code"}]}',
    "",
    "Diff:",
    "```diff",
    diff,
    "```",
  ]
    .filter(Boolean)
    .join("\n")
}

const SEVERITIES: ReviewSeverity[] = ["blocking", "concern", "nit"]
const VERDICTS: ReviewVerdict[] = ["approve", "comment", "request-changes"]

// Models wrap JSON in prose or fences despite instructions, so recover the
// object rather than failing the whole review on formatting.
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), text]
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return undefined
}

export function parseReview(text: string, knownFiles?: readonly string[]): PullRequestReview | undefined {
  const parsed = extractJson(text)
  if (!parsed || typeof parsed !== "object") return undefined
  const record = parsed as Record<string, unknown>
  const summary = typeof record.summary === "string" ? record.summary.trim() : ""
  if (!summary) return undefined

  const findings = (Array.isArray(record.findings) ? record.findings : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      file: typeof entry.file === "string" ? entry.file : "",
      line: typeof entry.line === "number" && Number.isFinite(entry.line) ? entry.line : undefined,
      severity: SEVERITIES.includes(entry.severity as ReviewSeverity) ? (entry.severity as ReviewSeverity) : "concern",
      title: typeof entry.title === "string" ? entry.title.trim() : "",
      detail: typeof entry.detail === "string" ? entry.detail.trim() : "",
      suggestion: typeof entry.suggestion === "string" && entry.suggestion.trim() ? entry.suggestion : undefined,
    }))
    // A finding naming a file outside the diff is a hallucination, not a
    // review comment — dropping it is what keeps this trustworthy enough to
    // post to someone else's pull request.
    .filter((finding) => finding.file && finding.title && (!knownFiles || knownFiles.includes(finding.file)))

  const claimed = VERDICTS.includes(record.verdict as ReviewVerdict) ? (record.verdict as ReviewVerdict) : "comment"
  return {
    summary,
    findings,
    // Never approve while holding a blocking finding, whatever the model said.
    verdict: findings.some((finding) => finding.severity === "blocking")
      ? "request-changes"
      : claimed === "approve" && findings.length === 0
        ? "approve"
        : claimed,
  }
}

const SEVERITY_LABEL: Record<ReviewSeverity, string> = {
  blocking: "**Blocking**",
  concern: "**Concern**",
  nit: "Nit",
}

export function formatReviewComment(review: PullRequestReview) {
  const lines = ["## Vector AI review", "", review.summary, ""]
  if (!review.findings.length) {
    lines.push("No issues found in this diff.")
    return lines.join("\n")
  }
  for (const order of SEVERITIES) {
    const group = review.findings.filter((finding) => finding.severity === order)
    for (const finding of group) {
      lines.push(
        `${SEVERITY_LABEL[order]} — \`${finding.file}${finding.line ? `:${finding.line}` : ""}\` — ${finding.title}`,
        "",
        finding.detail,
        "",
      )
      if (finding.suggestion) lines.push("```suggestion", finding.suggestion, "```", "")
    }
  }
  lines.push("", "_Reviewed locally by Vector._")
  return lines.join("\n")
}

export function countBySeverity(findings: readonly ReviewFinding[]) {
  return {
    blocking: findings.filter((finding) => finding.severity === "blocking").length,
    concern: findings.filter((finding) => finding.severity === "concern").length,
    nit: findings.filter((finding) => finding.severity === "nit").length,
  }
}
