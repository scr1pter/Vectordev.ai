export * as ResearchQuote from "./quote"

import { BrainLexical } from "../brain/lexical"
import { WebFence } from "./fence"

// A note's quote is checked twice, and the two checks answer different questions.
// 1. Is the quote in the source? It must be at least 12 characters and, once both are normalised (whitespace, curly
//    quotes, dashes, ligatures, full-width and other compatibility forms, soft hyphens and other invisible
//    characters), a substring of the source's saved, cleaned text. Case is kept: a quote with its capitals changed is
//    not word for word. Superscripts, subscripts and fractions are kept too, since folding them makes another number
//    (10\u2074 is not 104). This is what makes a citation real, so a quote that fails it is refused, and a note keeps
//    the source's own words for its quote, not the agent's copy.
// 2. Does the quote say the claim? `BrainLexical.states(claim, quote)`: every term of the claim, every value it gives
//    and every "not" in it, in the quote. A note whose quote does not is saved as a paraphrase, which cannot make a
//    section High confidence on its own.

export const MIN_CHARS = 12

// The characters Unicode decomposes as superscripts, subscripts and fractions (decomposition types super, sub and
// fraction, Unicode 17), and the unit squares with a superscript in them (\u33A2 is km\u00B2). NFKC would fold 10\u2074
// into 104 and 5\u00D710\u207B\u2076 into 5\u00D710-6, so a run of superscripts is written after a caret instead
// (10^4, 10^-6, km^2), a run of subscripts after an underscore (CO_2), and a fraction or a unit square as itself.
const SUPERSCRIPT =
  "\u00AA\u00B2\u00B3\u00B9\u00BA\u02B0-\u02B8\u02E0-\u02E4\u10FC\u1D2C-\u1D2E\u1D30-\u1D3A\u1D3C-\u1D4D\u1D4F-\u1D61\u1D78\u1D9B-\u1DBF\u2070\u2071\u2074-\u207F\u2120\u2122\u2C7D\u2D6F\u3192-\u319F\uA69C\uA69D\uA770\uA7F1-\uA7F4\uA7F8\uA7F9\uAB5C-\uAB5F\uAB69\u{10781}-\u{10785}\u{10787}-\u{107B0}\u{107B2}-\u{107BA}\u{1E030}-\u{1E050}\u{1E06B}-\u{1E06D}\u{1F16A}-\u{1F16C}"
const SUBSCRIPT = "\u1D62-\u1D6A\u2080-\u208E\u2090-\u209C\u2C7C\u{1E051}-\u{1E06A}"
const KEPT = "\u00BC-\u00BE\u2150-\u215F\u2189\u3378\u3379\u339F-\u33A6\u33A8\u33AF"
const RAISED = new RegExp(`^[${SUPERSCRIPT}]`, "u")
const LOWERED = new RegExp(`^[${SUBSCRIPT}]`, "u")
// Split on, so the runs and characters above are kept out of NFKC.
const MARKED = new RegExp(`([${SUPERSCRIPT}]+|[${SUBSCRIPT}]+|[${KEPT}])`, "u")
// What a quote's last character may carry after it: accents and other marks, and invisible characters.
const TRAILING = /^[\p{M}\p{Default_Ignorable_Code_Point}]*/u

export const SHORT = `A quote needs at least ${MIN_CHARS} characters, copied word for word from the source.`

export function missing(source: string, chunk?: number) {
  return chunk === undefined
    ? `That quote is not in ${source}. Copy the words from ${source}.`
    : `That quote is not in ${source}. Copy the words from ${source} chunk ${chunk}.`
}

/** One passage of a source's saved text, with the PDF page and the chunk it is in. */
export type Part = { readonly text: string; readonly chunk: number; readonly page?: number }

export type Found =
  | {
      readonly ok: true
      readonly chunk: number
      readonly page?: number
      /** The source's own words for the quote, with their spacing made single spaces. */
      readonly quote: string
    }
  | { readonly ok: false; readonly reason: "short" | "missing"; readonly message: string }

/** A text as quotes are compared: the same words in the same case, whatever their spacing, quote marks and dashes. */
export function normalize(text: string) {
  return WebFence.clean(text)
    .split(MARKED)
    .map((piece, index) => {
      if (index % 2 === 0) return piece.normalize("NFKC")
      if (RAISED.test(piece)) return `^${piece.normalize("NFKC")}`
      if (LOWERED.test(piece)) return `_${piece.normalize("NFKC")}`
      return piece
    })
    .join("")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

/** Whether a quote is in the source's saved text, and where: its chunk and, for a PDF, its page. */
export function found(input: {
  readonly source: string
  readonly parts: readonly Part[]
  readonly quote: string
}): Found {
  const quote = normalize(input.quote)
  if (quote.length < MIN_CHARS) return { ok: false, reason: "short", message: SHORT }
  const normal = input.parts.map((part) => normalize(part.text))
  // Where each part starts in the parts joined by one space.
  const state = { at: 0 }
  const starts = normal.map((text) => {
    const start = state.at
    state.at += text.length + 1
    return start
  })
  const at = normal.join(" ").indexOf(quote)
  if (at < 0)
    return { ok: false, reason: "missing", message: missing(input.source, closest(input.parts, normal, quote)) }
  const index = starts.findLastIndex((start) => start <= at)
  const part = input.parts[Math.max(0, index)]!
  return {
    ok: true,
    chunk: part.chunk,
    ...(part.page === undefined ? {} : { page: part.page }),
    quote: span(input.parts, starts, at, at + quote.length),
  }
}

/** Whether the quote says the claim, the same way round. False makes the note a paraphrase. */
export function supports(claim: string, quote: string) {
  return BrainLexical.states(claim, quote)
}

// The source's own text for the normalised characters from `from` to `to` of the parts joined by one space.
function span(parts: readonly Part[], starts: readonly number[], from: number, to: number) {
  const first = starts.findLastIndex((start) => start <= from)
  const last = starts.findLastIndex((start) => start < to)
  const text = parts
    .slice(first, last + 1)
    .map((part, index, all) =>
      part.text.slice(
        index === 0 ? opening(part.text, from - starts[first]!) : 0,
        index === all.length - 1 ? closing(part.text, to - starts[last]!) : part.text.length,
      ),
    )
    .join(" ")
  return WebFence.clean(text).replace(/\s+/g, " ").trim()
}

// Where the normalised character at `index` starts in `text`: the shortest start of the text whose normal form is
// longer than `index`, less its last character. A normal form only grows as the text does, so it is found by halving.
function opening(text: string, index: number) {
  return shortest(text.length, (length) => normalize(text.slice(0, length)).length > index) - 1
}

// Where the first `index` normalised characters end in `text`, with the marks over the last letter.
function closing(text: string, index: number) {
  const end = shortest(text.length, (length) => normalize(text.slice(0, length)).length >= index)
  return end + TRAILING.exec(text.slice(end))![0].length
}

// The least length up to `max` that passes `test`, for a test that every longer length passes too.
function shortest(max: number, test: (length: number) => boolean) {
  const state = { low: 0, high: max }
  while (state.low < state.high) {
    const middle = Math.floor((state.low + state.high) / 2)
    if (test(middle)) state.high = middle
    else state.low = middle + 1
  }
  return state.low
}

// The chunk whose words the quote shares most, to point the agent at the words to copy.
function closest(parts: readonly Part[], normal: readonly string[], quote: string) {
  const words = new Set(
    quote
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 3),
  )
  if (words.size === 0) return undefined
  const best = normal
    .map((text, index) => ({
      chunk: parts[index]!.chunk,
      shared: new Set(
        text
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => words.has(word)),
      ).size,
    }))
    .toSorted((left, right) => right.shared - left.shared)
    .at(0)
  return best && best.shared > 0 ? best.chunk : undefined
}
