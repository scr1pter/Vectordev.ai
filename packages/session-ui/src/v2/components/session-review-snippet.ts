import type { FileDiffMetadata } from "@pierre/diffs"

export type ReviewSnippetRow = { kind: "ctx" | "add" | "del"; text: string }

export type ReviewSnippet = {
  header: string
  rows: ReviewSnippetRow[]
  /** Hunks after the first, or, with a single hunk, the lines of it the snippet leaves out. */
  more?: { unit: "hunks" | "lines"; count: number }
}

type HunkBlock = FileDiffMetadata["hunks"][number]["hunkContent"][number]

const MAX_ROWS = 6
const LEADING_CONTEXT = 2

/**
 * The short preview a Changes row expands to: the first hunk's header (with its
 * function context when the patch has one), up to two context lines before its
 * first change block, then that block and whatever follows it in the hunk, capped
 * at six rows, without blank trailing context. Rows carry the " ", "+" or "-"
 * prefix as text, like the landing page replica. Undefined when the diff has no hunks.
 */
export function reviewSnippet(diff: FileDiffMetadata): ReviewSnippet | undefined {
  const hunk = diff.hunks[0]
  if (!hunk) return

  const blocks = hunk.hunkContent
  // A hunk without a change block (context only) previews its first lines.
  const first = Math.max(
    0,
    blocks.findIndex((block) => block.type === "change"),
  )
  const before = blocks[first - 1]
  const leading = before?.type === "context" ? blockRows(diff, before, before.lines - LEADING_CONTEXT) : []
  const shown = blocks
    .slice(first)
    .reduce((rows, block) => (rows.length >= MAX_ROWS ? rows : [...rows, ...blockRows(diff, block)]), leading)
    .slice(0, MAX_ROWS)
  // Blank trailing context only pads a six-row preview.
  const rows = shown.slice(0, shown.findLastIndex((row) => row.kind !== "ctx" || row.text.trim() !== "") + 1)
  const specs = `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`

  return {
    header: hunk.hunkContext ? `${specs} ${hunk.hunkContext}` : specs,
    rows,
    more: more(diff, rows.length),
  }
}

/** A block's rows from `start` on; a change block lists its deletions before its additions. */
function blockRows(diff: FileDiffMetadata, block: HunkBlock, start = 0): ReviewSnippetRow[] {
  if (block.type === "context")
    return range(Math.max(0, start), block.lines).map((i) =>
      row("ctx", diff.additionLines[block.additionLineIndex + i]),
    )
  return [
    ...range(0, block.deletions).map((i) => row("del", diff.deletionLines[block.deletionLineIndex + i])),
    ...range(0, block.additions).map((i) => row("add", diff.additionLines[block.additionLineIndex + i])),
  ]
}

function more(diff: FileDiffMetadata, shown: number): ReviewSnippet["more"] {
  if (diff.hunks.length > 1) return { unit: "hunks", count: diff.hunks.length - 1 }
  const total = diff.hunks[0]!.hunkContent.reduce(
    (sum, block) => sum + (block.type === "context" ? block.lines : block.additions + block.deletions),
    0,
  )
  if (total <= shown) return
  return { unit: "lines", count: total - shown }
}

function row(kind: ReviewSnippetRow["kind"], line: string | undefined): ReviewSnippetRow {
  const prefix = kind === "add" ? "+" : kind === "del" ? "-" : " "
  return { kind, text: prefix + (line ?? "").replace(/\r?\n$/, "") }
}

// Only the rows a snippet can show are materialized, so a 10k-line new file costs six.
function range(start: number, end: number) {
  const stop = Math.min(end, start + MAX_ROWS)
  return Array.from({ length: Math.max(0, stop - start) }, (_, i) => start + i)
}
