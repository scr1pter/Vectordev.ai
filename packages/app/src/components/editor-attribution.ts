// Works out which lines an agent just changed, so the editor can attribute a
// live edit to the agent that made it. The file.edited event names the file and
// the agent but carries no line ranges, so the ranges come from comparing the
// buffer before and after the external update.

export type LineRange = { start: number; end: number }

export type AgentAttribution = {
  agentId: string
  agentName: string
  color: string
  ranges: LineRange[]
  at: number
}

// Common prefix/suffix trimming rather than a full diff: an agent edit is
// usually a contiguous region, and this keeps a large file cheap to attribute
// on every update. Lines are 1-based to match Monaco.
export function changedLineRanges(before: string, after: string): LineRange[] {
  if (before === after) return []
  const a = before.split("\n")
  const b = after.split("\n")

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1

  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1
    endB -= 1
  }

  // Pure deletion: nothing remains to highlight, so mark the seam instead of
  // returning an inverted range Monaco would reject.
  if (endB < start) {
    const line = Math.min(start + 1, b.length)
    return b.length ? [{ start: line, end: line }] : []
  }
  return [{ start: start + 1, end: endB + 1 }]
}

// A stable colour per agent so the same agent keeps its colour across updates.
// Mirrors the palette the file tree already uses for workspace markers.
const PALETTE = [
  "#9374ec",
  "#4ec9b0",
  "#dcdcaa",
  "#ce9178",
  "#569cd6",
  "#c586c0",
  "#4fc1ff",
  "#b5cea8",
  "#f28b82",
  "#ffd479",
]

export function agentColor(agentId: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < agentId.length; i += 1) {
    hash ^= agentId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return PALETTE[hash % PALETTE.length]!
}

// Attributions fade so the editor shows recent activity rather than an
// ever-growing wash of colour over the whole file.
export const ATTRIBUTION_TTL_MS = 20_000

export function activeAttributions(all: readonly AgentAttribution[], now: number) {
  return all.filter((entry) => now - entry.at < ATTRIBUTION_TTL_MS)
}

// Newer attributions win a contested line: two agents editing the same region
// should show whoever touched it last, not an arbitrary one.
export function mergeAttribution(
  all: readonly AgentAttribution[],
  next: AgentAttribution,
  now: number,
): AgentAttribution[] {
  return [...activeAttributions(all, now).filter((entry) => entry.agentId !== next.agentId), next]
}

// Where the editor should scroll to (and label) after an agent edit. The token
// changes on every edit so the same lines edited twice still trigger a reveal.
export type AgentReveal = {
  path: string
  line: number
  endLine: number
  agentId: string
  agentName: string
  color: string
  token: number
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

// Prefer the colour the agent was configured with so the editor matches the
// chat, but only when it is a plain hex value: Monaco's overview ruler and the
// injected line tint both need a colour they can append alpha to.
export function resolveAgentColor(
  agentName: string | undefined,
  agents: readonly { name: string; color?: string }[],
  fallbackId: string,
) {
  const custom = agentName ? agents.find((agent) => agent.name === agentName)?.color : undefined
  if (custom && HEX_COLOR.test(custom)) return custom
  return agentColor(fallbackId)
}

function lineAt(text: string, offset: number) {
  let line = 1
  let index = text.indexOf("\n")
  while (index !== -1 && index < offset) {
    line += 1
    index = text.indexOf("\n", index + 1)
  }
  return line
}

// When the file was not loaded before the agent touched it there is no
// "before" to diff against. The edit tool's own input still says what text it
// inserted, so find that in the fresh buffer instead of washing the whole
// file. Formatters may reflow the inserted text, so fall back to its first
// non-blank line when the exact snippet is gone.
export function locateInsertedText(after: string, snippet: string): LineRange | undefined {
  const body = snippet.replace(/\r\n/g, "\n").replace(/\n+$/, "")
  if (!body.trim()) return
  const exact = after.indexOf(body)
  if (exact >= 0) return { start: lineAt(after, exact), end: lineAt(after, exact + body.length - 1) }

  const lines = body.split("\n")
  const probe = lines.find((line) => line.trim())?.trim()
  if (!probe) return
  const loose = after.indexOf(probe)
  if (loose < 0) return
  const start = lineAt(after, loose)
  const total = after.split("\n").length
  return { start, end: Math.min(start + lines.length - 1, total) }
}

// Ranges for an edit whose "before" is unknown, derived from the tool call that
// produced it: a write replaces the whole file, an edit inserts its newString.
export function inferredLineRanges(
  after: string,
  call: { tool: string; input: Record<string, unknown> } | undefined,
): LineRange[] {
  if (!call) return []
  if (call.tool === "write") return changedLineRanges("", after)
  if (call.tool === "edit" && typeof call.input.newString === "string") {
    const range = locateInsertedText(after, call.input.newString)
    return range ? [range] : []
  }
  return []
}

// The agent "cursor" sits where it stopped typing: the end of a short block,
// or the start of one too tall to fit on screen so the label stays visible
// after the reveal.
export const CURSOR_TAIL_MAX_LINES = 30

export function agentCursorLine(range: LineRange) {
  return range.end - range.start > CURSOR_TAIL_MAX_LINES ? range.start : range.end
}
