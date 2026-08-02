export type InlineCompletionContext = {
  path: string
  language: string
  prefix: string
  suffix: string
  cursorLine: number
}

export type CodespaceReplacement = {
  oldText: string
  newText: string
}

export type CodespaceProposalChange = {
  path: string
  mode: "edit" | "create"
  explanation: string
  risk: "low" | "medium" | "high"
  content: string
  replacements: CodespaceReplacement[]
}

export type CodespaceProposal = {
  summary: string
  changes: CodespaceProposalChange[]
}

export function isCodespaceEditRequest(input: string) {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^(please\s+|can you\s+|could you\s+|would you\s+)+/, "")
  if (!text) return false
  if (
    /\b(fix|change|edit|modify|implement|create|add|remove|delete|refactor|rename|replace|update|write|generate|convert|migrate|optimi[sz]e|format|apply)\b/.test(
      text,
    )
  )
    return true
  return !/^(explain|describe|summari[sz]e|what|why|how|where|which|review|analy[sz]e|inspect|show|tell|find)\b/.test(
    text,
  )
}

export function boundInlineCompletionContext(
  input: InlineCompletionContext,
  limits: { prefix?: number; suffix?: number } = {},
) {
  const prefixLimit = limits.prefix ?? 12_000
  const suffixLimit = limits.suffix ?? 4_000
  return {
    ...input,
    prefix: input.prefix.slice(-prefixLimit),
    suffix: input.suffix.slice(0, suffixLimit),
  }
}

export function sanitizeInlineCompletion(text: string, suffix: string) {
  const fenced = text.match(/^\s*```[^\n`]*\n([\s\S]*?)\n?```\s*$/)
  const suggestion = (fenced?.[1] ?? text).replace(/\r\n/g, "\n").replace(/^\n/, "").slice(0, 4_000)
  if (!suggestion.trim()) return
  if (suffix.startsWith(suggestion)) return
  return suggestion
}

export function parseCodespaceProposal(value: unknown): CodespaceProposal | undefined {
  if (!isRecord(value) || typeof value.summary !== "string" || !Array.isArray(value.changes)) return
  const changes = value.changes.flatMap((item) => {
    if (!isRecord(item)) return []
    const path = safeWorkspacePath(item.path)
    const mode = item.mode === "create" ? "create" : item.mode === "edit" ? "edit" : undefined
    const risk = item.risk === "low" || item.risk === "high" ? item.risk : item.risk === "medium" ? "medium" : undefined
    if (!path || !mode || !risk || typeof item.explanation !== "string" || typeof item.content !== "string") return []
    const replacements = Array.isArray(item.replacements)
      ? item.replacements.flatMap((replacement) => {
          if (!isRecord(replacement)) return []
          if (typeof replacement.oldText !== "string" || typeof replacement.newText !== "string") return []
          if (!replacement.oldText) return []
          return [{ oldText: replacement.oldText, newText: replacement.newText }]
        })
      : []
    if (mode === "edit" && !replacements.length) return []
    if (mode === "create" && !item.content) return []
    return [
      {
        path,
        mode,
        risk,
        explanation: item.explanation,
        content: item.content,
        replacements,
      } satisfies CodespaceProposalChange,
    ]
  })
  if (!changes.length) return
  return { summary: value.summary, changes }
}

export function parseCodespaceProposalText(text: string) {
  const normalized = text.trim()
  if (!normalized) return
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]
  const candidate = fenced ?? normalized.slice(normalized.indexOf("{"), normalized.lastIndexOf("}") + 1)
  if (!candidate) return
  try {
    return parseCodespaceProposal(JSON.parse(candidate))
  } catch {
    return
  }
}

export function applyExactReplacements(content: string, replacements: CodespaceReplacement[]) {
  return replacements.reduce(
    (state, replacement) => {
      const first = state.content.indexOf(replacement.oldText)
      const second = first < 0 ? -1 : state.content.indexOf(replacement.oldText, first + replacement.oldText.length)
      if (first < 0) {
        return { ...state, errors: [...state.errors, "The original code was not found."] }
      }
      if (second >= 0) {
        return { ...state, errors: [...state.errors, "The original code matched more than once."] }
      }
      return {
        content: `${state.content.slice(0, first)}${replacement.newText}${state.content.slice(first + replacement.oldText.length)}`,
        applied: state.applied + 1,
        errors: state.errors,
      }
    },
    { content, applied: 0, errors: [] as string[] },
  )
}

export function extractStructuredOutput(value: unknown): unknown {
  if (!isRecord(value)) return
  if (value.structured !== undefined) return value.structured
  for (const key of ["info", "message", "data"]) {
    const structured = extractStructuredOutput(value[key])
    if (structured !== undefined) return structured
  }
}

export function collectPatchFiles(value: unknown) {
  const files = new Set<string>()
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 6) return
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => visit(item, depth + 1))
      return
    }
    if (!isRecord(candidate)) return
    if (candidate.type === "patch" && Array.isArray(candidate.files)) {
      candidate.files.forEach((path) => {
        const safe = safeWorkspacePath(path)
        if (safe) files.add(safe)
      })
    }
    Object.values(candidate).forEach((item) => visit(item, depth + 1))
  }
  visit(value, 0)
  return [...files]
}

function safeWorkspacePath(value: unknown) {
  if (typeof value !== "string") return
  const path = value.trim().replaceAll("\\", "/")
  if (!path || path.startsWith("/") || /^[a-zA-Z]:\//.test(path)) return
  const parts = path.split("/").filter((part) => part && part !== ".")
  if (!parts.length || parts.includes("..")) return
  return parts.join("/")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
