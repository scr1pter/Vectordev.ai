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
