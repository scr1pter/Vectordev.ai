// What an agent is about to change, read from its running edit, write or
// apply_patch tool call. The server publishes file.edited only after the
// permission prompt, the write and the formatter, but the running tool part
// already names the file (and the text it will replace) the moment the model
// finishes the call. That lets the editor open the file and mark where the
// change will land before it happens.

import { parse as parsePatch } from "@opencode-ai/core/patch"
import { locateInsertedText, type LineRange } from "./editor-attribution"

export const EDIT_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "apply_patch"])

export type EditTargetKind = "edit" | "write" | "add" | "update" | "delete"

export type EditPatchChunk = {
  oldLines: readonly string[]
  newLines: readonly string[]
  changeContext?: string
}

export type EditTarget = {
  /** The path as the tool call wrote it: absolute, or relative to the directory. */
  file: string
  kind: EditTargetKind
  /** edit: the text being replaced. */
  oldText?: string
  /** edit: the replacement. write/add: the whole new file. */
  newText?: string
  /** apply_patch update hunks, in file order. */
  chunks?: readonly EditPatchChunk[]
  /** apply_patch "*** Move to:" destination. */
  movePath?: string
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

export function editTargets(tool: string, input: Record<string, unknown> | undefined): EditTarget[] {
  if (!input) return []
  if (tool === "edit") {
    const file = text(input.filePath)
    if (!file) return []
    return [{ file, kind: "edit", oldText: text(input.oldString), newText: text(input.newString) }]
  }
  if (tool === "write") {
    const file = text(input.filePath)
    if (!file) return []
    return [{ file, kind: "write", newText: text(input.content) }]
  }
  if (tool === "apply_patch") {
    const patch = text(input.patchText)
    if (!patch) return []
    return patchTargets(patch)
  }
  return []
}

export function patchTargets(patch: string): EditTarget[] {
  try {
    return parsePatch(patch).map((hunk): EditTarget => {
      if (hunk.type === "add") return { file: hunk.path, kind: "add", newText: hunk.contents }
      if (hunk.type === "delete") return { file: hunk.path, kind: "delete" }
      return {
        file: hunk.path,
        kind: "update",
        chunks: hunk.chunks.map((chunk) => ({
          oldLines: chunk.oldLines,
          newLines: chunk.newLines,
          changeContext: chunk.changeContext,
        })),
        ...(hunk.movePath ? { movePath: hunk.movePath } : {}),
      }
    })
  } catch {
    return scanPatchHeaders(patch)
  }
}

// A patch the strict parser rejects still names its files in the headers,
// which is all following needs to open the right file.
const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/

function scanPatchHeaders(patch: string): EditTarget[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n")
  const out: EditTarget[] = []
  for (const [index, raw] of lines.entries()) {
    const header = PATCH_HEADER.exec(raw.trim())
    const file = header?.[2]?.trim()
    if (!header || !file) continue
    const kind: EditTargetKind = header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update"
    const move = kind === "update" ? PATCH_MOVE.exec(lines[index + 1]?.trim() ?? "")?.[1]?.trim() : undefined
    out.push(move ? { file, kind, movePath: move } : { file, kind })
  }
  return out
}

/** The file a target leaves behind: a move lands at its destination. */
export function landingPath(target: EditTarget) {
  return target.movePath ?? target.file
}

// Where the change will land in the buffer as it is now, before the tool runs.
// Undefined when that cannot be known yet (the buffer is not loaded, or the
// text being replaced is not in it).
export function intentRange(buffer: string | undefined, target: EditTarget): LineRange | undefined {
  if (target.kind === "write" || target.kind === "add") return { start: 1, end: 1 }
  if (target.kind === "delete") return
  if (target.kind === "edit") {
    // An empty oldString creates the file.
    if (!target.oldText) return { start: 1, end: 1 }
    if (buffer === undefined) return
    return locateInsertedText(buffer, target.oldText)
  }
  if (buffer === undefined) return
  const chunk = target.chunks?.[0]
  if (!chunk) return
  const old = chunk.oldLines.join("\n")
  const found = old.trim() ? locateInsertedText(buffer, old) : undefined
  if (found) return found
  if (chunk.changeContext?.trim()) return locateInsertedText(buffer, chunk.changeContext)
  return
}

const lf = (value: string) => value.replace(/\r\n/g, "\n")
const sameText = (a: string, b: string) => lf(a).replace(/\n+$/, "") === lf(b).replace(/\n+$/, "")

// Whether a file's text can still be what it was before this change. A read
// that lands after the tool's write, but before its formatter, already holds
// the agent's own text: diffing the formatted file against it would attribute
// the formatter's lines rather than the agent's. Such a read is no "before".
// When the target does not say enough to tell, the text is taken as it is.
export function predatesEdit(buffer: string, target: EditTarget): boolean {
  const current = lf(buffer)
  if (target.kind === "write" || target.kind === "add") {
    return target.newText === undefined || !sameText(current, target.newText)
  }
  if (target.kind === "edit") {
    const old = target.oldText === undefined ? undefined : lf(target.oldText)
    const next = target.newText === undefined ? undefined : lf(target.newText)
    // An empty oldString writes the whole file.
    if (!old) return next === undefined || !sameText(current, next)
    // Text that no longer holds the old string is no proof on its own: only
    // the replacement already being there says the write landed.
    if (!current.includes(old)) return !(next && current.includes(next))
    // An insertion anchored on the text it replaces keeps that text, so only
    // the whole replacement already being there says the write landed.
    return !(next && next.includes(old) && current.includes(next))
  }
  if (target.kind === "update") {
    const chunk = target.chunks?.[0]
    const old = chunk?.oldLines.join("\n")
    if (!old?.trim() || current.includes(old)) return true
    const next = chunk?.newLines.join("\n")
    return !(next?.trim() && current.includes(next))
  }
  return true
}

// Replaying a landed edit as typing. The server writes the whole change at
// once, so the editor replays the difference in the agent's colour. Above this
// size the replay would be a blur, so the change is applied instantly instead.
export const TYPING_MAX_CHARS = 6000
export const TYPING_MAX_STEPS = 30
/** A typing arm older than this is stale. It covers a long permission wait. */
export const TYPING_ARM_MS = 120_000

export type TypingPlan = { offset: number; deleteLength: number; insert: string }

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

// Character-level common prefix and suffix: the one span that differs. An edit
// is usually one contiguous region; when it is not, the span covers all of the
// hunks and the size cap decides whether it is still worth replaying.
export function typingPlan(before: string, after: string, maxChars = TYPING_MAX_CHARS): TypingPlan | undefined {
  if (before === after) return
  const limit = Math.min(before.length, after.length)
  let start = 0
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
  // Never split a surrogate pair: an emoji must not be typed half at a time.
  if (start > 0 && isHighSurrogate(after.charCodeAt(start - 1))) start -= 1

  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1
    endAfter -= 1
  }
  if (endAfter < after.length && endAfter > start && isLowSurrogate(after.charCodeAt(endAfter))) {
    endBefore += 1
    endAfter += 1
  }

  const insert = after.slice(start, endAfter)
  if (insert.length > maxChars) return
  return { offset: start, deleteLength: endBefore - start, insert }
}

function splitKeepingNewlines(value: string) {
  const out: string[] = []
  let from = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\n") continue
    out.push(value.slice(from, index + 1))
    from = index + 1
  }
  if (from < value.length) out.push(value.slice(from))
  return out
}

// The insert, cut into at most maxSteps pieces: whole lines for a multi-line
// insert, characters for a single line. The pieces join back to the insert.
export function typingSteps(insert: string, maxSteps = TYPING_MAX_STEPS): string[] {
  if (!insert) return []
  const units = insert.includes("\n") ? splitKeepingNewlines(insert) : Array.from(insert)
  const size = Math.max(1, Math.ceil(units.length / Math.max(1, maxSteps)))
  const steps: string[] = []
  for (let index = 0; index < units.length; index += size) steps.push(units.slice(index, index + size).join(""))
  return steps
}
