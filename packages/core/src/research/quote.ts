export * as ResearchQuote from "./quote"

import { BrainLexical } from "../brain/lexical"
import { WebFence } from "./fence"

// A note's quote is checked twice, and the two checks answer different questions.
// 1. Is the quote in the source? It must be at least 12 characters and, once both are normalised (whitespace, curly
//    quotes, dashes, ligatures and other compatibility forms, soft hyphens and other invisible characters), a
//    substring of the source's saved, cleaned text. Case is kept: a quote with its capitals changed is not word for
//    word. This is what makes a citation real, so a quote that fails it is refused.
// 2. Does the quote say the claim? `BrainLexical.states(claim, quote)`: every term of the claim, every value it gives
//    and every "not" in it, in the quote. A note whose quote does not is saved as a paraphrase, which cannot make a
//    section High confidence on its own.

export const MIN_CHARS = 12

export const SHORT = `A quote needs at least ${MIN_CHARS} characters, copied word for word from the source.`

export function missing(source: string, chunk?: number) {
  return chunk === undefined
    ? `That quote is not in ${source}. Copy the words from ${source}.`
    : `That quote is not in ${source}. Copy the words from ${source} chunk ${chunk}.`
}

/** One passage of a source's saved text, with the PDF page and the chunk it is in. */
export type Part = { readonly text: string; readonly chunk: number; readonly page?: number }

export type Found =
  | { readonly ok: true; readonly chunk: number; readonly page?: number }
  | { readonly ok: false; readonly reason: "short" | "missing"; readonly message: string }

/** A text as quotes are compared: the same words in the same case, whatever their spacing, quote marks and dashes. */
export function normalize(text: string) {
  return WebFence.clean(text)
    .normalize("NFKC")
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
  return { ok: true, chunk: part.chunk, ...(part.page === undefined ? {} : { page: part.page }) }
}

/** Whether the quote says the claim, the same way round. False makes the note a paraphrase. */
export function supports(claim: string, quote: string) {
  return BrainLexical.states(claim, quote)
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
