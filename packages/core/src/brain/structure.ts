export * as BrainStructure from "./structure"

import { createHash } from "node:crypto"
import { Token } from "../util/token"
import type { BrainLimits } from "./document/limits"
import type { BrainDocument } from "./document/read"
import { BrainScan } from "./scan"
import type { BrainSchema } from "./schema"

// A read document as sections and passages. Sections follow the heading tree (a slide or a sheet is a section of its
// own) and passages are runs of blocks inside one section, sized for retrieval: about 320 tokens, at least 120 unless the
// section ends first, never more than 480 (a table or code block stays whole up to 600). Each passage carries a
// breadcrumb ("Auth spec > 3 Limits > 3.2 Retries (p.12)") and a content-addressed id, so an unchanged passage keeps
// its id, its keyword postings and its credit across a reindex or a new version. Ids are 60 bits wide, since one table
// holds every repository's rows and a content-addressed id cannot be drawn again when two collide.

export const TARGET = 320
export const MINIMUM = 120
export const MAXIMUM = 480
export const WHOLE = 600
/** Base32 characters in a passage's, a section's or a record's id after its letter: 60 bits. */
export const ID = 12

export type Section = {
  /**
   * "s" and 12 base32 characters of the hash of the document's id and the section's ordinal: sections are numbered
   * within their document, so the id names the document too. Passages and records name their section by ordinal.
   */
  readonly id: string
  readonly ordinal: number
  readonly parent?: number
  /** 0 for the text before the first heading. */
  readonly level: number
  readonly heading: string
  /** Headings from the top, such as "3 Limits > 3.2 Retries"; empty for the text before the first heading. */
  readonly path: string
  readonly kind: "section" | "slide" | "sheet"
  readonly pageStart?: number
  readonly pageEnd?: number
  readonly tokens: number
  readonly start: number
  readonly end: number
}

export type Passage = {
  /** "p" and 12 base32 characters of the hash of the repository, the lineage and the passage's normalised text. */
  readonly id: string
  readonly section: number
  readonly ordinal: number
  readonly page?: number
  readonly header: string
  readonly body: string
  readonly tokens: number
  readonly start: number
  readonly end: number
  readonly normHash: string
  /** Why the passage waits for the user, when it does. */
  readonly hold?: BrainDocument.Hold
}

export type Structured = {
  readonly sections: readonly Section[]
  readonly passages: readonly Passage[]
  /** The section each block belongs to, by block index. */
  readonly owners: readonly number[]
  /** Set when so much of the document is held (more than 5% of passages) that all of it waits for the user. */
  readonly hold?: BrainDocument.Hold
  readonly held: number
  readonly warnings: readonly BrainSchema.DocumentWarning[]
}

type Piece = {
  readonly start: number
  readonly end: number
  readonly body: string
  readonly tokens: number
  readonly page?: number
  readonly splittable: boolean
}

const PRIORITY: readonly BrainDocument.Hold[] = ["instruction-like", "hidden-unicode", "hidden-text"]

export function structure(
  extracted: BrainDocument.Extracted,
  input: {
    readonly repository: string
    readonly lineage: string
    /** The id of the document version being read. */
    readonly document: string
    readonly limits: BrainLimits.Limits
  },
): Structured {
  const sections: {
    ordinal: number
    parent?: number
    level: number
    heading: string
    path: string
    kind: Section["kind"]
    blocks: number[]
  }[] = []
  const stack: { ordinal: number; level: number; heading: string }[] = []
  const owners: number[] = []
  // A top heading that repeats the document's title is already in every breadcrumb.
  const titled = (heading: { readonly level: number; readonly heading: string }) =>
    heading.level <= 1 && normalise(heading.heading) === normalise(extracted.title)
  for (const [index, block] of extracted.blocks.entries()) {
    if (block.type === "heading" && sections.length < input.limits.output.sections) {
      const level = block.section ? 1 : block.level
      while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop()
      const ordinal = sections.length
      sections.push({
        ordinal,
        ...(stack.length > 0 ? { parent: stack.at(-1)!.ordinal } : {}),
        level,
        heading: block.text,
        path: [...stack, { level, heading: block.text }]
          .filter((item, at) => at > 0 || !titled(item))
          .map((item) => item.heading)
          .join(" > "),
        kind: block.section ?? "section",
        blocks: [index],
      })
      stack.push({ ordinal, level, heading: block.text })
      owners.push(ordinal)
      continue
    }
    if (sections.length === 0)
      sections.push({ ordinal: 0, level: 0, heading: extracted.title, path: "", kind: "section", blocks: [] })
    const owner = stack.at(-1)?.ordinal ?? 0
    sections[owner]!.blocks.push(index)
    owners.push(owner)
  }
  const ids = new Map<string, number>()
  const passages: Passage[] = []
  const state = { truncated: false }
  for (const section of sections) {
    const pieces = section.blocks.flatMap((index) => {
      const block = extracted.blocks[index]!
      // A section's own heading is its breadcrumb, not its text.
      return block.type === "heading" && index === section.blocks[0] ? [] : split(block, extracted.text)
    })
    for (const group of pack(pieces)) {
      if (passages.length >= input.limits.output.passages) {
        state.truncated = true
        break
      }
      const body = group.reduce(
        (out, piece, index) =>
          index === 0 ? piece.body : `${out}${extracted.text.slice(group[index - 1]!.end, piece.start)}${piece.body}`,
        "",
      )
      const start = group[0]!.start
      const end = group.at(-1)!.end
      const page = group.find((piece) => piece.page !== undefined)?.page
      const normal = normalise(body)
      const seen = ids.get(normal) ?? 0
      ids.set(normal, seen + 1)
      const overlapping = extracted.flags
        .filter((flag) => flag.start < end && flag.end > start)
        .map((flag) => flag.hold)
      const holds = [...overlapping, ...(BrainScan.instructionLike(body, true) ? (["instruction-like"] as const) : [])]
      const hold = PRIORITY.find((item) => holds.includes(item))
      passages.push({
        id: `p${base32(sha256(`${input.repository}\0${input.lineage}\0${normal}${seen > 0 ? `\0${seen + 1}` : ""}`)).slice(0, ID)}`,
        section: section.ordinal,
        ordinal: passages.length,
        ...(page === undefined ? {} : { page }),
        header: `${extracted.title}${section.path ? ` > ${section.path}` : ""}${page === undefined ? "" : ` (p.${page})`}`,
        body,
        tokens: Token.estimate(body),
        start,
        end,
        normHash: normHash(body),
        ...(hold ? { hold } : {}),
      })
    }
  }
  const held = passages.filter((passage) => passage.hold).length
  const counts = passages.reduce(
    (all, passage) => (passage.hold ? all.set(passage.hold, (all.get(passage.hold) ?? 0) + 1) : all),
    new Map<BrainDocument.Hold, number>(),
  )
  const most = [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0]
  return {
    sections: sections.map((section) => {
      const blocks = section.blocks.map((index) => extracted.blocks[index]!)
      const pages = blocks.flatMap((block) => (block.span.page === undefined ? [] : [block.span.page]))
      const start = blocks[0]?.span.start ?? 0
      const end = blocks.at(-1)?.span.end ?? start
      return {
        id: `s${base32(sha256(`${input.document}\0${section.ordinal}`)).slice(0, ID)}`,
        ordinal: section.ordinal,
        ...(section.parent === undefined ? {} : { parent: section.parent }),
        level: section.level,
        heading: section.heading,
        path: section.path,
        kind: section.kind,
        ...(pages.length > 0 ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : {}),
        tokens: Token.estimate(extracted.text.slice(start, end)),
        start,
        end,
      }
    }),
    passages,
    owners,
    ...(most && held > 0.05 * passages.length ? { hold: most } : {}),
    held,
    warnings: state.truncated ? ["truncated"] : [],
  }
}

// A block as pieces no larger than a passage: whole when it fits, else split at sentences, list items, table rows (the
// header repeated on every piece) or code lines.
function split(block: BrainDocument.Block, text: string): Piece[] {
  const page = block.span.page === undefined ? {} : { page: block.span.page }
  const whole = text.slice(block.span.start, block.span.end)
  const tokens = Token.estimate(whole)
  const limit = block.type === "table" || block.type === "code" ? WHOLE : MAXIMUM
  if (tokens <= limit)
    return [
      {
        start: block.span.start,
        end: block.span.end,
        body: whole,
        tokens,
        ...page,
        splittable: block.type === "paragraph" || block.type === "quote",
      },
    ]
  const units =
    block.type === "list"
      ? block.items.map((item) => item.span)
      : block.type === "table" || block.type === "code"
        ? lines(whole, block.span.start).slice(block.type === "table" && block.header.length > 0 ? 1 : 0)
        : sentences(whole, block.span.start)
  const header = block.type === "table" && block.header.length > 0 ? `${shorten(block.header.join(" | "))}\n` : ""
  const groups = units.reduce<{ start: number; end: number }[][]>((all, unit) => {
    const last = all.at(-1)
    if (last && Token.estimate(header + text.slice(last[0]!.start, unit.end)) <= MAXIMUM) last.push(unit)
    else all.push([unit])
    return all
  }, [])
  return groups.flatMap((group) => {
    const start = group[0]!.start
    const end = group.at(-1)!.end
    const slice = text.slice(start, end)
    // A sentence or line longer than a passage on its own is cut at whitespace.
    if (Token.estimate(header + slice) > MAXIMUM)
      return hard(start, end, text, Math.max(HARD, MAXIMUM * 4 - header.length)).map((part) => ({
        ...part,
        body: header + part.body,
        tokens: Token.estimate(header + part.body),
        ...page,
        splittable: false,
      }))
    return [{ start, end, body: header + slice, tokens: Token.estimate(header + slice), ...page, splittable: false }]
  })
}

// Pieces into passages: add until the next piece would pass the maximum, close at the target. A passage still under
// the minimum when the next piece cannot fit takes the next piece's leading sentences instead of closing short.
function pack(pieces: readonly Piece[]): Piece[][] {
  const groups: Piece[][] = []
  const current: Piece[] = []
  const size = () => current.reduce((sum, piece) => sum + piece.tokens, 0)
  const close = () => {
    if (current.length > 0) groups.push(current.splice(0))
  }
  const queue = [...pieces]
  while (queue.length > 0) {
    const piece = queue.shift()!
    if (current.length > 0 && size() + piece.tokens > MAXIMUM) {
      if (size() < MINIMUM && piece.splittable) {
        const parts = fill(piece, MAXIMUM - size())
        if (parts) {
          current.push(parts[0])
          close()
          queue.unshift(parts[1])
          continue
        }
      }
      close()
    }
    current.push(piece)
    if (size() >= TARGET) close()
  }
  close()
  return groups
}

// A piece split after the last sentence that still fits in `room` tokens.
function fill(piece: Piece, room: number): [Piece, Piece] | undefined {
  const units = sentences(piece.body, piece.start)
  const head = units.filter((unit) => Token.estimate(piece.body.slice(0, unit.end - piece.start)) <= room).at(-1)
  const rest = head ? units.find((unit) => unit.start >= head.end) : undefined
  if (!head || !rest) return undefined
  const page = piece.page === undefined ? {} : { page: piece.page }
  const first = piece.body.slice(0, head.end - piece.start)
  const second = piece.body.slice(rest.start - piece.start)
  return [
    { start: piece.start, end: head.end, body: first, tokens: Token.estimate(first), ...page, splittable: true },
    { start: rest.start, end: piece.end, body: second, tokens: Token.estimate(second), ...page, splittable: true },
  ]
}

// A table header repeated on every piece of a split table takes at most a quarter of a passage, so the rows always have
// room: a header past that is cut at a word and ends in an ellipsis.
const HEADER = MAXIMUM

function shorten(header: string) {
  if (header.length <= HEADER) return header
  const cut = header.lastIndexOf(" ", HEADER - 1)
  return `${header.slice(0, cut > HEADER / 2 ? cut : HEADER - 1)}…`
}

/** The fewest characters a hard cut takes, so a cut always moves forward. */
const HARD = 400

function hard(start: number, end: number, text: string, chars: number) {
  const parts: { start: number; end: number; body: string }[] = []
  for (let at = start; at < end; ) {
    const limit = Math.min(end, at + chars)
    const space = limit < end ? text.lastIndexOf(" ", limit) : limit
    const stop = space > at + chars / 2 ? space : limit
    parts.push({ start: at, end: stop, body: text.slice(at, stop) })
    at = stop
    while (at < end && /\s/.test(text[at]!)) at++
  }
  return parts
}

function lines(text: string, offset: number) {
  const parts = text.split("\n")
  const lengths = parts.map((part) => part.length)
  return starts(lengths, offset).map((start, index) => ({ start, end: start + lengths[index]! }))
}

/** Where each of several lines joined by "\n" starts, counting from `start`. */
export function starts(lengths: readonly number[], start: number) {
  const out: number[] = []
  for (const [index] of lengths.entries()) out.push(index === 0 ? start : out[index - 1]! + lengths[index - 1]! + 1)
  return out
}

// Abbreviations that end in a full stop without ending a sentence.
const ABBREVIATION =
  /(?:\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|Mr|Mrs|Ms|Dr|Prof|Fig|No|Nos|Sec|Sect|Eq|Ref|Vol|Inc|Ltd|Co|Corp|St|Jr|Sr|al)|\b[A-Z])\.$/

/** Sentence spans in a text: a sentence ends at ".", "!" or "?" before whitespace and a capital, digit or quote. */
export function sentences(text: string, offset = 0) {
  const spans: { start: number; end: number }[] = []
  const pattern = /[.!?]+["')\]]*(?=\s+["'“(\[]?[\p{Lu}\d])|\n{2,}/gu
  const state = { start: 0 }
  for (const match of text.matchAll(pattern)) {
    const end = match.index! + match[0].length
    if (
      match[0].startsWith(".") &&
      ABBREVIATION.test(text.slice(Math.max(state.start, match.index! - 8), match.index! + 1))
    )
      continue
    push(spans, text, state.start, match[0].startsWith("\n") ? match.index! : end, offset)
    state.start = end
  }
  push(spans, text, state.start, text.length, offset)
  return spans
}

function push(spans: { start: number; end: number }[], text: string, from: number, to: number, offset: number) {
  const lead = text.slice(from, to).match(/^\s*/)![0].length
  const trail = text.slice(from, to).match(/\s*$/)![0].length
  if (to - trail > from + lead) spans.push({ start: offset + from + lead, end: offset + to - trail })
}

/** Lowercased words and numbers only, the form two texts are compared in. */
export function normalise(text: string) {
  return BrainScan.stripHidden(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** The same digest as `Brain.normHash`, kept here so the document reader needs nothing from the brain service. */
export function normHash(text: string) {
  return sha256(normalise(text)).toString("hex").slice(0, 24)
}

export function sha256(text: string) {
  return createHash("sha256").update(text).digest()
}

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"

/** Crockford base32, the alphabet every brain id uses. */
export function base32(bytes: Uint8Array) {
  const state = { bits: 0, value: 0, out: "" }
  for (const byte of bytes) {
    state.value = ((state.value << 8) | byte) & 0xffff
    state.bits += 8
    while (state.bits >= 5) {
      state.out += ALPHABET[(state.value >>> (state.bits - 5)) & 31]
      state.bits -= 5
    }
  }
  if (state.bits > 0) state.out += ALPHABET[(state.value << (5 - state.bits)) & 31]
  return state.out
}
