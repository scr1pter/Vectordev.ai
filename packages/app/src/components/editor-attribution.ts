// Works out which lines an agent just changed, so the editor can attribute a
// live edit to the agent that made it. The file.edited event names the file and
// the agent but carries no line ranges, so the ranges come from comparing the
// buffer before and after the external update.

import { parse as parsePatch } from "@opencode-ai/core/patch"
import { diffLines } from "diff"

export type LineRange = { start: number; end: number }

export type AgentAttribution = {
  /** Workspace-relative file the ranges belong to. */
  path: string
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
// should show whoever touched it last, not an arbitrary one. Keyed by file as
// well as agent, so an agent working across several files keeps a highlight in
// each of them rather than only the one it touched last.
export function mergeAttribution(
  all: readonly AgentAttribution[],
  next: AgentAttribution,
  now: number,
): AgentAttribution[] {
  return [
    ...activeAttributions(all, now).filter((entry) => entry.agentId !== next.agentId || entry.path !== next.path),
    next,
  ]
}

/** The entries that belong to one file — ranges are meaningless in any other. */
export function attributionsForPath(all: readonly AgentAttribution[], path: string) {
  return all.filter((entry) => entry.path === path)
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

function countNewlines(text: string, from: number, to: number) {
  let count = 0
  for (let index = text.indexOf("\n", from); index !== -1 && index < to; index = text.indexOf("\n", index + 1)) {
    count += 1
  }
  return count
}

function mergeRanges(ranges: readonly LineRange[]) {
  const out: LineRange[] = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
      continue
    }
    out.push({ start: range.start, end: Math.max(range.start, range.end) })
  }
  return out
}

// Above this the line diff costs more than a live edit is worth, so the single
// prefix/suffix range is used instead.
export const DIFF_LINE_RANGES_MAX_CHARS = 300_000

// The line diff's cost grows with the square of the lines that differ: a
// whole-file rewrite of a few thousand lines takes seconds on the main thread,
// well under the size cap. Past this budget it gives up, and the single
// prefix/suffix range is used instead.
export const DIFF_LINE_RANGES_TIMEOUT_MS = 50

// One range per changed block, so an edit that touches two separate functions
// tints those two blocks rather than everything between them. A deletion
// leaves no line to tint, so it marks the seam where the text was, as
// changedLineRanges does.
export function diffLineRanges(before: string, after: string): LineRange[] {
  if (before === after) return []
  if (before.length + after.length > DIFF_LINE_RANGES_MAX_CHARS) return changedLineRanges(before, after)
  const changes = diffLines(before, after, { ignoreNewlineAtEof: true, timeout: DIFF_LINE_RANGES_TIMEOUT_MS })
  if (!changes) return changedLineRanges(before, after)
  const total = after.split("\n").length
  const ranges: LineRange[] = []
  let line = 1
  for (const change of changes) {
    if (change.removed) {
      const seam = Math.max(1, Math.min(line, total))
      ranges.push({ start: seam, end: seam })
      continue
    }
    if (change.added && change.count > 0) ranges.push({ start: line, end: Math.min(line + change.count - 1, total) })
    line += change.count
  }
  return mergeRanges(ranges)
}

// locateInsertedText, but when the snippet appears more than once the match
// closest to where the change was expected to land wins, so a repeated line
// is attributed where the agent actually wrote it.
export function locateInsertedTextNear(after: string, snippet: string, nearLine?: number): LineRange | undefined {
  if (nearLine === undefined) return locateInsertedText(after, snippet)
  const body = snippet.replace(/\r\n/g, "\n").replace(/\n+$/, "")
  if (!body.trim()) return
  const height = body.split("\n").length - 1
  let best: LineRange | undefined
  let line = 1
  let scanned = 0
  let index = after.indexOf(body)
  for (let seen = 0; index !== -1 && seen < 200; seen += 1) {
    line += countNewlines(after, scanned, index)
    scanned = index
    if (!best || Math.abs(line - nearLine) < Math.abs(best.start - nearLine)) best = { start: line, end: line + height }
    index = after.indexOf(body, index + 1)
  }
  return best ?? locateInsertedText(after, snippet)
}

export type InferredRangeOptions = {
  /** Where the change was expected to land; the nearest match wins when the inserted text repeats. */
  nearLine?: number
  /** apply_patch: the file `after` belongs to, compared after normalize. */
  path?: string
  normalize?: (file: string) => string | undefined
}

// An apply_patch update chunk carries its context lines on both sides, so the
// chunk's new lines are found in the file and only the lines that differ from
// the chunk's old lines are attributed. Chunks are in file order, so each one
// is searched for after the previous.
function patchLineRanges(after: string, patchText: string, options: InferredRangeOptions): LineRange[] {
  let hunks: ReturnType<typeof parsePatch>
  try {
    hunks = parsePatch(patchText)
  } catch {
    return []
  }
  const normalize = options.normalize ?? ((file: string) => file)
  const hunk =
    options.path === undefined
      ? hunks.length === 1
        ? hunks[0]
        : undefined
      : hunks.find(
          (item) => normalize(item.type === "update" && item.movePath ? item.movePath : item.path) === options.path,
        )
  if (!hunk || hunk.type === "delete") return []
  if (hunk.type === "add") return changedLineRanges("", after)
  const ranges: LineRange[] = []
  let from = 0
  for (const chunk of hunk.chunks) {
    const block = chunk.newLines.join("\n")
    if (!block.trim()) continue
    const index = after.indexOf(block, from)
    if (index === -1) {
      // A formatter reflowed the chunk; attribute the whole block it became.
      const loose = locateInsertedText(after, block)
      if (loose) ranges.push(loose)
      continue
    }
    const blockStart = 1 + countNewlines(after, 0, index)
    for (const range of diffLineRanges(chunk.oldLines.join("\n"), block)) {
      ranges.push({ start: blockStart + range.start - 1, end: blockStart + range.end - 1 })
    }
    from = index + block.length
  }
  return mergeRanges(ranges)
}

// Ranges for an edit whose "before" is unknown (or already equals the new
// text), derived from the tool call that produced it: a write replaces the
// whole file, an edit inserts its newString, and an apply_patch update
// inserts each chunk's new lines.
export function inferredLineRanges(
  after: string,
  call: { tool: string; input: Record<string, unknown> } | undefined,
  options: InferredRangeOptions = {},
): LineRange[] {
  if (!call) return []
  if (call.tool === "write") return changedLineRanges("", after)
  if (call.tool === "edit" && typeof call.input.newString === "string") {
    const range = locateInsertedTextNear(after, call.input.newString, options.nearLine)
    return range ? [range] : []
  }
  if (call.tool === "apply_patch" && typeof call.input.patchText === "string") {
    return patchLineRanges(after, call.input.patchText, options)
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
