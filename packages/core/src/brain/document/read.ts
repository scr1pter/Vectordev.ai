export * as BrainDocument from "./read"

import type { BrainSchema } from "../schema"
import { BrainScan } from "../scan"
import { BrainStructure } from "../structure"
import { BrainData } from "./data"
import { BrainHtml } from "./html"
import { refuse, type BrainLimits } from "./limits"
import { BrainMarkdown } from "./markdown"
import { BrainOoxml } from "./ooxml"
import { BrainSniff } from "./sniff"
import { BrainText } from "./text"

// One shape for every format. A reader turns a file into drafts (blocks without offsets); `read` lays them out into
// one text, cleans each block on the way (hidden characters out, secrets redacted, wrapper tags neutralised) and
// records each block's span in that text, so a record's quote is always an exact slice of what was stored.

/** Offsets into `Extracted.text`, which is NFC with "\n" line breaks. */
export type Span = { readonly page?: number; readonly start: number; readonly end: number }

export type ListItem = {
  readonly text: string
  readonly depth: number
  readonly code: readonly string[]
  readonly span: Span
}

export type Block =
  | {
      readonly type: "heading"
      readonly level: number
      readonly text: string
      readonly span: Span
      /** A slide or a sheet: a section of its own whatever its level. */
      readonly section?: "slide" | "sheet"
    }
  | { readonly type: "paragraph"; readonly text: string; readonly code: readonly string[]; readonly span: Span }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly ListItem[]; readonly span: Span }
  | {
      readonly type: "table"
      readonly header: readonly string[]
      readonly rows: readonly (readonly string[])[]
      /** 1 for a table the file marks as one, lower for one inferred from layout. */
      readonly confidence: number
      readonly span: Span
      /** Where each row came from, such as "Limits!12" for a spreadsheet row. */
      readonly refs?: readonly string[]
    }
  | { readonly type: "code"; readonly language?: string; readonly text: string; readonly span: Span }
  | { readonly type: "quote"; readonly text: string; readonly span: Span }

export type Hold = "hidden-text" | "hidden-unicode" | "instruction-like"

export type Flag = { readonly start: number; readonly end: number; readonly hold: Hold }

export type Extracted = {
  readonly type: "extracted"
  /** From the file's metadata, first heading, front matter or name: at most 80 characters, scanned. */
  readonly title: string
  readonly format: BrainSchema.Format
  readonly pages?: number
  /** Pages with no text layer, or that pdf.js could not read. */
  readonly unread: readonly number[]
  readonly text: string
  readonly blocks: readonly Block[]
  /** Recorded, never fetched. */
  readonly links: readonly string[]
  readonly flags: readonly Flag[]
  readonly warnings: readonly BrainSchema.DocumentWarning[]
}

export type Refusal = "too-large" | "unsupported" | "encrypted" | "empty" | "secret" | "invalid"

export type ReadRefusal = { readonly type: "refused"; readonly reason: Refusal; readonly message: string }

export type Input = { readonly name: string; readonly bytes: Uint8Array; readonly mime?: string }

/**
 * What a reader produces for one block. `hidden`: text a reader of the file would not see was dropped from it.
 * `instruction`: the block's source (markup the reader removed included) reads as instructions to an AI.
 */
export type Draft = { readonly page?: number; readonly hidden?: boolean; readonly instruction?: boolean } & (
  | { readonly type: "heading"; readonly level: number; readonly text: string; readonly section?: "slide" | "sheet" }
  | { readonly type: "paragraph"; readonly text: string; readonly code?: readonly string[] }
  | {
      readonly type: "list"
      readonly ordered: boolean
      readonly items: readonly { readonly text: string; readonly depth: number; readonly code?: readonly string[] }[]
    }
  | {
      readonly type: "table"
      readonly header: readonly string[]
      readonly rows: readonly (readonly string[])[]
      readonly confidence: number
      readonly refs?: readonly string[]
    }
  | { readonly type: "code"; readonly language?: string; readonly text: string }
  | { readonly type: "quote"; readonly text: string }
)

export type Read = {
  readonly type: "read"
  readonly format: BrainSchema.Format
  readonly title?: string
  readonly pages?: number
  readonly unread?: readonly number[]
  readonly drafts: readonly Draft[]
  readonly links?: readonly string[]
  readonly warnings?: readonly BrainSchema.DocumentWarning[]
}

/**
 * Reads a document into blocks. Every reader is synchronous except the PDF reader (pdf.js answers in promises), which
 * is also the only heavy one, so it loads on the first PDF.
 */
export async function read(
  input: Input,
  limits: BrainLimits.Limits,
  signal?: AbortSignal,
): Promise<Extracted | ReadRefusal> {
  const sniffed = BrainSniff.sniff(input, limits)
  if (sniffed.type === "refused") return sniffed
  const result = await dispatch(sniffed, input.bytes, limits, signal)
  if (result.type === "refused") return result
  const extracted = await layout(input.name, result, limits, signal)
  if (extracted.blocks.length === 0 && extracted.unread.length === 0)
    return refuse("empty", "This document has no text Vector can read.")
  return extracted
}

async function dispatch(
  sniffed: BrainSniff.Sniffed,
  bytes: Uint8Array,
  limits: BrainLimits.Limits,
  signal: AbortSignal | undefined,
) {
  if (sniffed.format === "pdf") {
    const { BrainPdf } = await import("./pdf")
    return BrainPdf.read(bytes, limits, signal)
  }
  if (sniffed.format === "docx" || sniffed.format === "pptx" || sniffed.format === "xlsx")
    return BrainOoxml.read(sniffed.format, bytes, limits)
  const text = BrainSniff.decode(bytes)
  if (sniffed.format === "csv") return BrainData.csv(text, sniffed.delimiter, limits)
  if (sniffed.format === "markdown") return BrainMarkdown.read(text, limits)
  if (sniffed.format === "html") return BrainHtml.read(text, limits)
  if (sniffed.format === "json" || sniffed.format === "yaml") return BrainData.read(text, sniffed.format, limits)
  return BrainText.read(text)
}

// Text that could open or close one of Vector's own wrappers (`</vector_memory_recall>`, `<document_passage>`, `<system>`)
// loses its "<", so a passage can never end the data it is quoted in.
const TAG = /<(?=\/?[A-Za-z_][\w-]*)/g

/** A block's text as it is stored: NFC, hidden characters removed, secrets redacted, wrapper tags neutralised. */
export function clean(text: string) {
  // A soft hyphen is typesetting, not a hiding place, so it goes without a flag.
  const normal = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")
  const visible = BrainScan.stripHidden(normal)
  const redacted = BrainScan.redact(visible)
  return {
    text: redacted.text.replace(TAG, "‹"),
    hidden: visible !== normal,
    redactions: count(redacted.text) - count(visible),
  }
}

function count(text: string) {
  return text.split("[redacted]").length - 1
}

async function layout(name: string, input: Read, limits: BrainLimits.Limits, signal?: AbortSignal): Promise<Extracted> {
  const out = {
    text: "",
    blocks: [] as Block[],
    flags: [] as Flag[],
    redactions: 0,
    truncated: false,
  }
  const pieces = (texts: readonly string[]) => {
    const cleaned = texts.map(clean)
    out.redactions += cleaned.reduce((sum, item) => sum + item.redactions, 0)
    return { texts: cleaned.map((item) => item.text), hidden: cleaned.some((item) => item.hidden) }
  }
  for (const [index, draft] of input.drafts.entries()) {
    const room = limits.chars - out.text.length - 2
    // Cleaning is most of a read's work. On the main thread the event loop gets a turn every 200 blocks, and a read
    // told to stop keeps what it laid out so far.
    if (limits.yield && index > 0 && index % 200 === 0) await new Promise((resolve) => setImmediate(resolve))
    if (room <= 0 || signal?.aborted) {
      out.truncated = true
      break
    }
    const placed = place(draft, pieces, room)
    if (!placed) continue
    if (placed.cut) out.truncated = true
    const start = out.text.length + (out.text.length > 0 ? 2 : 0)
    out.text += `${out.text.length > 0 ? "\n\n" : ""}${placed.text}`
    const block = placed.block(start, draft.page)
    out.blocks.push(block)
    const span = { start, end: out.text.length }
    if (draft.hidden) out.flags.push({ ...span, hold: "hidden-text" })
    if (placed.hidden) out.flags.push({ ...span, hold: "hidden-unicode" })
    if (draft.instruction || BrainScan.instructionLike(placed.text, true))
      out.flags.push({ ...span, hold: "instruction-like" })
  }
  const warnings = new Set([
    ...(input.warnings ?? []),
    ...(out.truncated ? (["truncated"] as const) : []),
    ...(out.redactions > 20 ? (["secrets-removed"] as const) : []),
    ...((input.unread ?? []).length > 0 ? (["scanned"] as const) : []),
  ])
  return {
    type: "extracted",
    title: title(input, out.blocks, name),
    format: input.format,
    ...(input.pages === undefined ? {} : { pages: input.pages }),
    unread: input.unread ?? [],
    text: out.text,
    blocks: out.blocks,
    links: [
      ...new Set(
        (input.links ?? []).filter((link) => /^(?:https?|mailto):/i.test(link)).map((link) => clean(link).text),
      ),
    ].slice(0, 1_000),
    flags: out.flags,
    warnings: [...warnings],
  }
}

// One draft's stored text and the block it becomes once its offset is known, or nothing for a draft left empty.
function place(
  draft: Draft,
  pieces: (texts: readonly string[]) => { readonly texts: readonly string[]; readonly hidden: boolean },
  room: number,
) {
  const span = (start: number, end: number, page?: number): Span =>
    page === undefined ? { start, end } : { page, start, end }
  if (draft.type === "list") {
    const cleaned = pieces(draft.items.map((item) => item.text))
    const codes = draft.items.map((item) =>
      pieces(item.code ?? [])
        .texts.map((code) => code.trim())
        .filter(Boolean),
    )
    const items = draft.items.flatMap((item, index) => {
      const text = oneLine(cleaned.texts[index]!)
      return text
        ? [{ depth: item.depth, text, code: [...new Set(codes[index]!.filter((code) => text.includes(code)))] }]
        : []
    })
    const fitting = items.slice(
      0,
      fits(
        items.map((item) => item.text.length),
        room,
      ),
    )
    if (fitting.length === 0) return undefined
    return {
      text: fitting.map((item) => item.text).join("\n"),
      hidden: cleaned.hidden,
      cut: fitting.length < items.length,
      block: (start: number, page?: number): Block => {
        const offsets = BrainStructure.starts(
          fitting.map((item) => item.text.length),
          start,
        )
        return {
          type: "list",
          ordered: draft.ordered,
          items: fitting.map((item, index) => ({
            ...item,
            span: span(offsets[index]!, offsets[index]! + item.text.length, page),
          })),
          span: span(start, start + fitting.map((item) => item.text).join("\n").length, page),
        }
      },
    }
  }
  if (draft.type === "table") {
    const width = draft.rows.reduce((widest, row) => Math.max(widest, row.length), draft.header.length)
    const header = pieces(draft.header).texts.map(oneLine)
    const cleaned = draft.rows.map((row) => pieces(row))
    const rows = cleaned.map((row) => row.texts.map(oneLine))
    const lines = [...(header.some(Boolean) ? [header] : []), ...rows].map((row) => row.join(" | "))
    const fitting = lines.slice(
      0,
      fits(
        lines.map((line) => line.length),
        room,
      ),
    )
    const kept = rows.slice(0, fitting.length - (header.some(Boolean) ? 1 : 0))
    if (fitting.length === 0 || (kept.length === 0 && rows.length > 0) || width === 0) return undefined
    return {
      text: fitting.join("\n"),
      hidden: cleaned.some((row) => row.hidden),
      cut: kept.length < rows.length,
      block: (start: number, page?: number): Block => ({
        type: "table",
        header: header.some(Boolean) ? header : [],
        rows: kept,
        confidence: draft.confidence,
        span: span(start, start + fitting.join("\n").length, page),
        ...(draft.refs ? { refs: draft.refs.slice(0, kept.length) } : {}),
      }),
    }
  }
  const cleaned = pieces([draft.text, ...(draft.type === "paragraph" ? (draft.code ?? []) : [])])
  const whole = draft.type === "code" ? cleaned.texts[0]!.replace(/^\n+|\s+$/g, "") : cleaned.texts[0]!.trim()
  if (!whole) return undefined
  const text = whole.length > room ? whole.slice(0, room) : whole
  const heading = draft.type === "heading" ? oneLine(text) : text
  return {
    text: heading,
    hidden: cleaned.hidden,
    cut: text.length < whole.length,
    block: (start: number, page?: number): Block => {
      const at = span(start, start + heading.length, page)
      if (draft.type === "heading")
        return {
          type: "heading",
          level: draft.level,
          text: heading,
          span: at,
          ...(draft.section ? { section: draft.section } : {}),
        }
      if (draft.type === "paragraph")
        return {
          type: "paragraph",
          text: heading,
          code: [
            ...new Set(
              cleaned.texts
                .slice(1)
                .map((code) => code.trim())
                .filter(Boolean),
            ),
          ],
          span: at,
        }
      if (draft.type === "code")
        return { type: "code", text: heading, span: at, ...(draft.language ? { language: draft.language } : {}) }
      return { type: "quote", text: heading, span: at }
    },
  }
}

// How many lines, joined by "\n", fit in `room` characters.
function fits(lengths: readonly number[], room: number) {
  const state = { used: -1, count: 0 }
  for (const length of lengths) {
    if (state.used + length + 1 > room) break
    state.used += length + 1
    state.count++
  }
  return state.count
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function title(input: Read, blocks: readonly Block[], name: string) {
  const file = name
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[A-Za-z0-9]{1,8}$/, "")
  const first = blocks.find((block) => block.type === "heading" && block.level <= 1)
  const candidate = [input.title, first?.type === "heading" ? first.text : undefined, file]
    .map((text) => oneLine(clean(text ?? "").text))
    .find((text) => text.length > 0 && !BrainScan.instructionLike(text, true))
  return (candidate ?? "Untitled document").slice(0, 80).trim()
}
