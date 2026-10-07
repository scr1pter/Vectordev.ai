// The output schemas the reviewers answer with, and lenient decoding of what they return. The schemas use only
// conservative JSON Schema (no anyOf, no $ref, no additionalProperties: false), because providers differ in
// what they accept for a forced tool call.

import {
  CATEGORIES,
  SEVERITIES,
  type Category,
  type ModelFinding,
  type ModelReport,
  type Risk,
  type Severity,
} from "./types"

export const MAX_TITLE_CHARS = 100
// More findings than this is not a review; the rest are ignored.
export const MAX_REPORT_FINDINGS = 100
// The summary asks for two or three sentences; the summary comment shows at most 1,500 characters of it.
export const MAX_SUMMARY_CHARS = 4_000
// A longer fix is dropped rather than cut: half a fix is worse than none, and GitHub refuses comments over 65,536
// characters.
export const MAX_SUGGESTION_CHARS = 8_000
export const MAX_SUGGESTION_LINES = 80

const RISKS: Risk[] = ["low", "medium", "high"]

export const REVIEW_REPORT_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Two or three sentences: what the change does and the main risk it carries.",
    },
    risk: { type: "string", enum: [...RISKS] },
    files: {
      type: "array",
      description: "The changed files that matter most, each with a few words on why.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          note: { type: "string", description: "Why this file matters, in a few words." },
        },
        required: ["path", "note"],
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path." },
          line: { type: "integer", minimum: 1, description: "First line of the problem, as a head line number." },
          endLine: { type: "integer", minimum: 1, description: "Last line, when the problem spans several lines." },
          side: { type: "string", enum: ["RIGHT", "LEFT"], description: "LEFT only for removed code." },
          severity: { type: "string", enum: [...SEVERITIES] },
          category: { type: "string", enum: [...CATEGORIES] },
          title: { type: "string", maxLength: MAX_TITLE_CHARS },
          body: { type: "string", description: "What goes wrong, when, and why, citing the code you read." },
          suggestion: {
            type: "string",
            description: "The exact replacement for line..endLine, with the same indentation and no fences.",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: { type: "array", items: { type: "string" }, description: "path:line references you read." },
          rule: { type: "string", description: "The repository rule this breaks, quoted." },
          duplicateOf: { type: "string", description: "The id of an open earlier finding this repeats." },
        },
        required: ["path", "line", "severity", "category", "title", "body", "confidence"],
      },
    },
    priorStatus: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["fixed", "open"] },
          reason: { type: "string" },
        },
        required: ["id", "status", "reason"],
      },
    },
  },
  required: ["summary", "risk", "files", "findings"],
}

export const VERIFY_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["confirmed", "rejected"] },
          reason: { type: "string", description: "One sentence." },
        },
        required: ["id", "verdict", "reason"],
      },
    },
  },
  required: ["results"],
}

export interface VerifyResult {
  id: string
  verdict: "confirmed" | "rejected"
  reason: string
}

// Models wrap JSON in prose or fences despite instructions. Try fenced blocks and balanced objects/arrays,
// then the whole text. A decoder can skip unrelated JSON such as a tool result quoted before its report.
export function extractJson(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  const candidates: string[] = []
  for (const match of text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) candidates.push(match[1] ?? "")
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let position = 0; position < text.length; position++) {
    const char = text[position]
    if (start === -1) {
      if (char !== "{" && char !== "[") continue
      start = position
      depth = 1
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === "{" || char === "[") depth++
    else if (char === "}" || char === "]") {
      depth--
      if (depth) continue
      candidates.push(text.slice(start, position + 1))
      start = -1
    }
  }
  candidates.push(text)
  for (const candidate of candidates) {
    if (!candidate.trim()) continue
    try {
      const value: unknown = JSON.parse(candidate)
      if (value && typeof value === "object" && accept(value)) return value
    } catch {
      continue
    }
  }
  return undefined
}

// Accepts `info.structured`, or the text of the last message. A missing side becomes RIGHT, an unknown severity
// concern and an unknown category bug; numbers given as strings are converted and every value is clamped.
// Findings without a path or a title are dropped. Returns undefined when there is no report at all.
export function decodeReport(input: unknown): ModelReport | undefined {
  const value =
    typeof input === "string"
      ? (extractJson(input, (candidate) => isRecord(candidate) && Array.isArray(candidate.findings)) ??
        extractJson(input, (candidate) => isRecord(candidate) && !!text(candidate.summary)))
      : input
  if (!isRecord(value)) return undefined
  const summary = text(value.summary).slice(0, MAX_SUMMARY_CHARS)
  if (!Array.isArray(value.findings) && !summary) return undefined
  const report: ModelReport = {
    summary,
    risk: RISKS.find((risk) => risk === lower(value.risk)) ?? "low",
    files: list(value.files).flatMap((entry) => {
      if (!isRecord(entry)) return []
      const path = cleanPath(text(entry.path))
      return path ? [{ path, note: oneLine(text(entry.note)) }] : []
    }),
    findings: list(value.findings)
      .flatMap((entry) => {
        const finding = decodeFinding(entry)
        return finding ? [finding] : []
      })
      .slice(0, MAX_REPORT_FINDINGS),
  }
  const priorStatus = list(value.priorStatus).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const id = text(entry.id)
    const status = lower(entry.status)
    if (!id || (status !== "fixed" && status !== "open")) return []
    return [{ id, status, reason: oneLine(text(entry.reason)) } as const]
  })
  if (priorStatus.length) report.priorStatus = priorStatus
  return report
}

export function decodeVerify(input: unknown): VerifyResult[] | undefined {
  const value =
    typeof input === "string"
      ? (extractJson(input, (candidate) =>
          isRecord(candidate)
            ? Array.isArray(candidate.results)
            : Array.isArray(candidate) &&
              candidate.some(
                (entry) => isRecord(entry) && !!text(entry.id) && /^(confirm|reject)/.test(lower(entry.verdict)),
              ),
        ) ?? extractJson(input, Array.isArray))
      : input
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : undefined
  if (!entries) return undefined
  return entries.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return []
    const id = text(entry.id)
    const said = lower(entry.verdict)
    const verdict = said.startsWith("confirm") ? "confirmed" : said.startsWith("reject") ? "rejected" : undefined
    if (!id || !verdict) return []
    return [{ id, verdict, reason: oneLine(text(entry.reason)) } as VerifyResult]
  })
}

function decodeFinding(input: unknown): ModelFinding | undefined {
  if (!isRecord(input)) return undefined
  const path = cleanPath(text(input.path))
  const title = oneLine(text(input.title)).slice(0, MAX_TITLE_CHARS)
  if (!path || !title) return undefined
  // A finding with no usable line keeps line 1, so it is anchored or listed rather than lost.
  const line = Math.max(1, integer(input.line) ?? 1)
  const finding: ModelFinding = {
    path,
    line,
    side: lower(input.side) === "left" ? "LEFT" : "RIGHT",
    severity: SEVERITIES.find((severity: Severity) => severity === lower(input.severity)) ?? "concern",
    category: CATEGORIES.find((category: Category) => category === lower(input.category)) ?? "bug",
    title,
    body: text(input.body),
    confidence: confidence(input.confidence),
  }
  const endLine = integer(input.endLine)
  if (endLine !== undefined && endLine > line) finding.endLine = endLine
  const suggestion = cleanSuggestion(input.suggestion)
  if (suggestion !== undefined) finding.suggestion = suggestion
  const evidence = list(input.evidence)
    .flatMap((entry) => (typeof entry === "string" && entry.trim() ? [entry.trim()] : []))
    .slice(0, 20)
  if (evidence.length) finding.evidence = evidence
  const rule = oneLine(text(input.rule)).slice(0, 300)
  if (rule) finding.rule = rule
  const duplicateOf = text(input.duplicateOf)
  if (duplicateOf) finding.duplicateOf = duplicateOf
  return finding
}

// Models that ignore the schema sometimes answer in percent; 1 < c <= 100 is read as a percentage. A missing
// confidence becomes 0.5, which is below the default threshold, so an unrated finding is counted, not posted.
function confidence(input: unknown): number {
  const value = typeof input === "string" ? Number.parseFloat(input) : typeof input === "number" ? input : Number.NaN
  if (!Number.isFinite(value)) return 0.5
  const scaled = value > 1 && value <= 100 ? value / 100 : value
  return Math.min(1, Math.max(0, scaled))
}

function integer(input: unknown): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) return Math.round(input)
  if (typeof input !== "string") return undefined
  const match = input.match(/\d+/)
  return match ? Number(match[0]) : undefined
}

function cleanPath(path: string): string {
  return path.replace(/^(\.\/|\/)+/, "")
}

// The replacement text keeps its indentation. A fence around it and trailing blank lines are removed.
function cleanSuggestion(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  let value = input.replace(/\r\n?/g, "\n")
  const fenced = value.match(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/)
  if (fenced) value = fenced[2] ?? ""
  value = value.replace(/^\n+/, "").replace(/\s+$/, "")
  if (value.length > MAX_SUGGESTION_CHARS || value.split("\n").length > MAX_SUGGESTION_LINES) return undefined
  return value.trim() ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function lower(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}
