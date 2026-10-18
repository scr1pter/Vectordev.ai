export * as BrainParse from "./parse"

import type { BrainSchema } from "./schema"

// Reads the files people write (RULES.md, MEMORY.md, the legacy BRAIN.md) and Vector's failure memory into items the
// brain can index, budget and cite. Files stay the source of truth: nothing here writes, and an item's id comes from
// its file and text, so the same line keeps the same id (and its pin) however often the file is read.

export type Item = {
  readonly text: string
  readonly kind: BrainSchema.Kind
  readonly paths: readonly string[]
  /** 1-based first and last line of the item in the file. */
  readonly line: number
  readonly end: number
  readonly heading?: string
  /** Failure memory only: the record's signature. */
  readonly signature?: string
}

/** HTML comments become blank space of the same shape, so line numbers still point at the file. */
function uncomment(content: string) {
  return content.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ""))
}

type Block = { kind: "bullet" | "paragraph"; lines: string[]; line: number; heading?: string }

// Top-level bullets (with whatever is indented under them) and paragraphs. A fenced code block stays inside the item it
// opens in, so a command example is never split from the line that explains it.
function blocks(content: string) {
  const lines = uncomment(content).split("\n")
  const found: Block[] = []
  const state: { current?: Block; heading?: string; fence: boolean } = { fence: false }
  const close = () => {
    if (state.current) found.push(state.current)
    state.current = undefined
  }
  lines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, "")
    if (state.fence) {
      state.current?.lines.push(line)
      if (/^\s*(?:```|~~~)/.test(line)) state.fence = false
      return
    }
    if (/^\s*(?:```|~~~)/.test(line)) {
      if (!state.current) state.current = { kind: "paragraph", lines: [], line: index + 1, heading: state.heading }
      state.current.lines.push(line)
      state.fence = true
      return
    }
    if (!line.trim()) return close()
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      close()
      state.heading = heading[1]!.trim()
      return
    }
    const bullet = /^( ?)(?:[-*+]|\d+[.)])\s+\S/.test(line)
    if (bullet) {
      close()
      state.current = { kind: "bullet", lines: [line], line: index + 1, heading: state.heading }
      return
    }
    if (state.current) {
      state.current.lines.push(line)
      return
    }
    state.current = { kind: "paragraph", lines: [line], line: index + 1, heading: state.heading }
  })
  close()
  return found
}

function text(block: Block) {
  if (block.kind === "paragraph") return block.lines.join("\n").trim()
  const [first, ...rest] = block.lines
  const head = first!.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
  return [head, ...rest.map((line) => line.replace(/^ {2,4}/, ""))].join("\n").trim()
}

const SCOPED = /^([\s\S]*\S) \(applies to (.+)\)$/
// What Vectorscope's "Don't flag this again" writes. Every review reads RULES.md itself, so these lines only ever
// matter there, and a coding request no longer carries them.
const REVIEW = /^code review:\s*(?:do not|don't)\s+flag\b/i

/** A rules file: each bullet or paragraph is a rule, scoped when it ends with "(applies to …)". */
export function rules(content: string): Item[] {
  return blocks(content).map((block) => {
    const body = text(block)
    const scoped = block.lines.length === 1 ? SCOPED.exec(body) : null
    return {
      text: body,
      kind: REVIEW.test(body) ? "review" : "rule",
      paths: scoped ? scoped[2]!.split(",").flatMap((pattern) => (pattern.trim() ? [pattern.trim()] : [])) : [],
      line: block.line,
      end: block.line + block.lines.length - 1,
      ...(block.heading ? { heading: block.heading } : {}),
    }
  })
}

/**
 * The rules file as the agent reads it: as written, without comments or the lines `omit` picks (review-only lines and
 * lines held for review).
 */
export function rulesText(content: string, omit: (item: Item) => boolean) {
  const lines = uncomment(content).split("\n")
  const dropped = new Set(
    rules(content)
      .filter(omit)
      .flatMap((item) => Array.from({ length: item.end - item.line + 1 }, (_, offset) => item.line + offset)),
  )
  const kept = lines.filter((_, index) => !dropped.has(index + 1)).map((line) => line.replace(/\s+$/, ""))
  // A heading with nothing left under it says nothing to the agent.
  const pruned = kept.filter((line, index) => {
    if (!/^#{1,6}\s/.test(line)) return true
    const next = kept.slice(index + 1).find((later) => later.trim() !== "")
    return next !== undefined && !/^#{1,6}\s/.test(next)
  })
  return pruned
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** MEMORY.md: each bullet or paragraph is something the user told Vector about themselves. */
export function memory(content: string): Item[] {
  return blocks(content).map((block) => ({
    text: text(block),
    kind: "preference",
    paths: [],
    line: block.line,
    end: block.line + block.lines.length - 1,
    ...(block.heading ? { heading: block.heading } : {}),
  }))
}

export function memoryText(content: string) {
  return uncomment(content)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// The legacy BRAIN.md had no structure beyond its headings, so a heading's words say what its items are.
function guess(heading: string | undefined): BrainSchema.Kind {
  if (!heading) return "lesson"
  if (/decision|decided|chose|choice/i.test(heading)) return "decision"
  if (/prefer|style|taste/i.test(heading)) return "preference"
  if (/fact|architecture|overview|structure|layout|where|map/i.test(heading)) return "fact"
  return "lesson"
}

/** The legacy BRAIN.md: read-only now, one item per bullet or paragraph, recalled when relevant. */
export function brain(content: string): Item[] {
  return blocks(content).map((block) => ({
    text: text(block),
    kind: guess(block.heading),
    paths: [],
    line: block.line,
    end: block.line + block.lines.length - 1,
    ...(block.heading ? { heading: block.heading } : {}),
  }))
}

type FailureRecord = {
  signature?: unknown
  checkLabel?: unknown
  checkId?: unknown
  occurrences?: unknown
  lastSeen?: unknown
  flakyPasses?: unknown
  flakyFailures?: unknown
  repair?: { files?: unknown; description?: unknown }
}

/**
 * Vector's failure memory: a check that failed this exact way before and the repair that fixed it, or a check that
 * flips with no change at all. A record with neither says nothing an agent could use, so it is left out.
 */
export function failures(content: string): Item[] {
  const parsed = (() => {
    try {
      return JSON.parse(content) as { records?: unknown }
    } catch {
      return undefined
    }
  })()
  const records = Array.isArray(parsed?.records) ? (parsed.records as FailureRecord[]) : []
  return records.flatMap((record, index) => {
    if (typeof record?.signature !== "string") return []
    const label = typeof record.checkLabel === "string" ? record.checkLabel : String(record.checkId ?? "A check")
    const times = Number.isFinite(record.occurrences) ? Number(record.occurrences) : 1
    const seen = typeof record.lastSeen === "string" ? record.lastSeen.slice(0, 10) : ""
    const flaky = Number(record.flakyPasses ?? 0) + Number(record.flakyFailures ?? 0) > 0
    const files = Array.isArray(record.repair?.files)
      ? (record.repair.files as unknown[]).filter((file): file is string => typeof file === "string")
      : []
    const description =
      typeof record.repair?.description === "string" ? record.repair.description.replace(/\s+/g, " ").trim() : ""
    const repair = record.repair
      ? `A repair that worked touched ${files.slice(0, 5).join(", ") || "no tracked files"}${description ? `: ${description.slice(0, 240)}` : "."}`
      : ""
    if (!repair && !flaky) return []
    const parts = [
      `${label} has failed this exact way ${times} time${times === 1 ? "" : "s"}${seen ? ` (last ${seen})` : ""}.`,
      flaky ? "It also flips outcome with no code change, so re-run it before editing anything." : "",
      repair,
    ]
    return [
      {
        text: parts.filter(Boolean).join(" "),
        kind: "failure" as const,
        // Reading a file a repeated repair touched brings the repair along: "when you change A, also look at B".
        paths: times >= 2 ? files.slice(0, 5) : [],
        line: index + 1,
        end: index + 1,
        signature: record.signature,
      },
    ]
  })
}
