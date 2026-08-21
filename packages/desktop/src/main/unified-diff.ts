export type UnifiedDiffHunk = {
  id: string
  filePath: string
  header: string
  lines: string[]
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export type UnifiedDiffFile = {
  path: string
  headers: string[]
  hunks: UnifiedDiffHunk[]
  raw: string
  binary: boolean
  supportsHunks: boolean
}

export type UnifiedDiffSelection = {
  hunkIds?: string[]
  files?: string[]
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
  const match = declaration.match(/^diff --(?:git|vector) (?:"?a\/)?(.+?)"? (?:"?b\/)?(.+?)"?$/)
  return (match?.[2] ?? match?.[1] ?? "unknown").replace(/^b\//, "")
}

export function parseUnifiedDiff(diff: string): UnifiedDiffFile[] {
  // Split on \n only. Git writes a diff's own structure (diff --git, @@, ---,
  // +++) with bare newlines, so a \r surviving on a line belongs to the file's
  // CRLF content. Normalising it away stripped those CRs from the +/- and
  // context lines, and the patch selectUnifiedDiff rebuilt from them no longer
  // matched the file on disk — every selective merge of a CRLF file was
  // rejected by git apply as "patch does not apply".
  const lines = diff.split("\n")
  const starts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^diff --(?:git|vector) /.test(lines[index] ?? "")) starts.push(index)
  }

  return starts.map((start, blockIndex) => {
    const end = starts[blockIndex + 1] ?? lines.length
    const block = lines.slice(start, end)
    while (block.at(-1) === "") block.pop()
    const path = filePathFromBlock(block)
    const hunkStarts: number[] = []
    for (let index = 0; index < block.length; index += 1) {
      if (block[index]?.startsWith("@@")) hunkStarts.push(index)
    }

    const hunks: UnifiedDiffHunk[] = []
    let invalidHunk = false
    for (let index = 0; index < hunkStarts.length; index += 1) {
      const hunkStart = hunkStarts[index]!
      const hunkEnd = hunkStarts[index + 1] ?? block.length
      const hunkLines = block.slice(hunkStart, hunkEnd)
      const header = hunkLines[0] ?? ""
      const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!match) {
        invalidHunk = true
        continue
      }
      const identity = `${path}\n${header}\n${hunkLines.join("\n")}`
      hunks.push({
        id: stableId(identity),
        filePath: path,
        header,
        lines: hunkLines,
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
      })
    }

    const firstHunk = hunkStarts[0] ?? block.length
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
      headers: block.slice(0, firstHunk),
      hunks,
      raw: block.join("\n"),
      binary: block.some((line) => line.startsWith("Binary files ") || line === "GIT binary patch"),
      supportsHunks:
        !wholeFileOnly && hunkStarts.length > 0 && !invalidHunk && hunks.length === hunkStarts.length,
    }
  })
}

export function selectUnifiedDiff(diff: string, selection: UnifiedDiffSelection) {
  const files = new Set(selection.files ?? [])
  const hunks = new Set(selection.hunkIds ?? [])
  const selected: string[] = []

  for (const file of parseUnifiedDiff(diff)) {
    if (files.has(file.path)) {
      selected.push(file.raw)
      continue
    }
    const picked = file.hunks.filter((hunk) => hunks.has(hunk.id))
    if (!picked.length) continue
    if (!file.supportsHunks) {
      throw new Error(`${file.path} can only be merged as a complete file.`)
    }
    selected.push([...file.headers, ...picked.flatMap((hunk) => hunk.lines)].join("\n"))
  }

  return selected.length ? `${selected.join("\n")}\n` : ""
}
