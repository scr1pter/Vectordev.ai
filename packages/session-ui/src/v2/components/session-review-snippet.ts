import type { FileDiffMetadata } from "@pierre/diffs"

export type ReviewSnippetRow = { kind: "ctx" | "add" | "del"; text: string }

export type ReviewSnippet = {
  header: string
  rows: ReviewSnippetRow[]
  /** Hunks after the first, or, with a single hunk, the lines of it the snippet leaves out. */
  more?: { unit: "hunks" | "lines"; count: number }
}

const MAX_ROWS = 6
const LEADING_CONTEXT = 2

/**
 * The short preview a Changes row expands to: the first hunk's header, up to two
 * context lines before its first change block, that block, and trailing context,
 * capped at six rows. Rows carry the " ", "+" or "-" prefix as text, like the
 * landing page replica. Undefined when the diff has no hunks.
 */
export function reviewSnippet(diff: FileDiffMetadata): ReviewSnippet | undefined {
  const hunk = diff.hunks[0]
  if (!hunk) return

  const blocks = hunk.hunkContent
  const first = blocks.findIndex((block) => block.type === "change")
  const change = blocks[first]
  const before = blocks[first - 1]
  const after = blocks[first + 1]

  const leading =
    before?.type === "context"
      ? range(Math.max(0, before.lines - LEADING_CONTEXT), before.lines).map((i) =>
          row("ctx", diff.additionLines[before.additionLineIndex + i]),
        )
      : []
  const changed =
    change?.type === "change"
      ? [
          ...range(0, change.deletions).map((i) => row("del", diff.deletionLines[change.deletionLineIndex + i])),
          ...range(0, change.additions).map((i) => row("add", diff.additionLines[change.additionLineIndex + i])),
        ]
      : []
  const trailing =
    after?.type === "context"
      ? range(0, after.lines).map((i) => row("ctx", diff.additionLines[after.additionLineIndex + i]))
      : []
  // A hunk without a change block (context only) still previews its first lines.
  const context =
    first < 0 && blocks[0]?.type === "context"
      ? range(0, blocks[0].lines).map((i) => row("ctx", diff.additionLines[blocks[0]!.additionLineIndex + i]))
      : []
  const rows = [...leading, ...changed, ...trailing, ...context].slice(0, MAX_ROWS)

  return {
    header: `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
    rows,
    more: more(diff, rows.length),
  }
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
