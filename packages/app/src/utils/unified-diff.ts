export type ReviewDiffHunk = {
  id: string
  filePath: string
  header: string
  lines: string[]
  oldStart: number
  newStart: number
}

export type ReviewDiffFile = {
  path: string
  hunks: ReviewDiffHunk[]
  raw: string
  supportsHunks: boolean
  binary: boolean
}

export type ReviewDiffRow = {
  oldLine?: number
  newLine?: number
  oldText?: string
  newText?: string
  kind: "context" | "change"
}

function stableId(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `hunk-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function filePathFromBlock(lines: string[]) {
  const target = lines.find((line) => line.startsWith("+++ "))?.slice(4).trim()
  if (target && target !== "/dev/null") return target.replace(/^b\//, "")
  const declaration = lines[0] ?? ""
  const paths = declaration.match(/^diff --(?:git|vector)\s+(?:"?a\/)?(.+?)"?\s+(?:"?b\/)?(.+?)"?$/)
  return (paths?.[2] ?? paths?.[1] ?? "unknown").replace(/^b\//, "")
}

export function parseReviewDiff(diff: string): ReviewDiffFile[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n")
  const starts = lines.flatMap((line, index) => (/^diff --(?:git|vector) /.test(line) ? [index] : []))

  return starts.map((start, blockIndex) => {
    const block = lines.slice(start, starts[blockIndex + 1] ?? lines.length)
    while (block.at(-1) === "") block.pop()
    const path = filePathFromBlock(block)
    const hunkStarts = block.flatMap((line, index) => (line.startsWith("@@") ? [index] : []))
    let invalid = false
    const hunks = hunkStarts.flatMap((hunkStart, hunkIndex) => {
      const hunkLines = block.slice(hunkStart, hunkStarts[hunkIndex + 1] ?? block.length)
      const header = hunkLines[0] ?? ""
      const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!match) {
        invalid = true
        return []
      }
      return [
        {
          id: stableId(`${path}\n${header}\n${hunkLines.join("\n")}`),
          filePath: path,
          header,
          lines: hunkLines,
          oldStart: Number(match[1]),
          newStart: Number(match[3]),
        },
      ]
    })
    const wholeFileOnly = block.some(
      (line) =>
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line === "--- /dev/null" ||
        line === "+++ /dev/null" ||
        line.startsWith("Binary files ") ||
        line === "GIT binary patch",
    )
    return {
      path,
      hunks,
      raw: block.join("\n"),
      binary: block.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch"),
      supportsHunks: !wholeFileOnly && !invalid && hunks.length > 0 && hunks.length === hunkStarts.length,
    }
  })
}

export function reviewRows(hunk: ReviewDiffHunk): ReviewDiffRow[] {
  const rows: ReviewDiffRow[] = []
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const lines = hunk.lines.slice(1)

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? ""
    if (line.startsWith(" ")) {
      rows.push({
        oldLine,
        newLine,
        oldText: line.slice(1),
        newText: line.slice(1),
        kind: "context",
      })
      oldLine += 1
      newLine += 1
      index += 1
      continue
    }
    if (line.startsWith("-") || line.startsWith("+")) {
      const removed: string[] = []
      const added: string[] = []
      while ((lines[index] ?? "").startsWith("-")) {
        removed.push((lines[index] ?? "").slice(1))
        index += 1
      }
      while ((lines[index] ?? "").startsWith("+")) {
        added.push((lines[index] ?? "").slice(1))
        index += 1
      }
      const count = Math.max(removed.length, added.length)
      for (let offset = 0; offset < count; offset += 1) {
        const oldText = removed[offset]
        const newText = added[offset]
        rows.push({
          oldLine: oldText === undefined ? undefined : oldLine++,
          newLine: newText === undefined ? undefined : newLine++,
          oldText,
          newText,
          kind: "change",
        })
      }
      continue
    }
    index += 1
  }
  return rows
}
