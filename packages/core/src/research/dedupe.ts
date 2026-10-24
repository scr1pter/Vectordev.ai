export * as ResearchDedupe from "./dedupe"

import { createHash } from "crypto"

// When a page is a copy of one already read: the same canonical address, the same cleaned text (sha256), or nearly
// the same words. Nearness is read from 5-word shingles: a Jaccard similarity of 0.85 or more, or a syndicated copy
// that holds at least 90% of the smaller text's shingles (syndication often trims a section or adds a line, which
// moves Jaccard but not containment). A copy is "duplicate of S#" and does not count as an independent source.

export const SHINGLE = 5
export const JACCARD = 0.85
export const CONTAINMENT = 0.9
// Texts with fewer shingles than this are compared by hash only, so two short notices are not called copies.
export const MIN_SHINGLES = 30
// Words read per text, so a very long page costs a bounded amount.
const MAX_WORDS = 50_000

export type Fingerprint = {
  readonly hash: string
  readonly shingles: ReadonlySet<string>
}

export type Known = Fingerprint & { readonly id: string; readonly canonical: string }

/** The hash and shingles of a page's cleaned text. */
export function fingerprint(text: string): Fingerprint {
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_WORDS)
  const shingles = new Set(
    words.length < SHINGLE
      ? []
      : words.slice(0, words.length - SHINGLE + 1).map((_, index) => words.slice(index, index + SHINGLE).join(" ")),
  )
  return { hash: createHash("sha256").update(words.join(" ")).digest("hex"), shingles }
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return 0
  const shared = overlap(left, right)
  return shared / (left.size + right.size - shared)
}

/** The share of the smaller set that is in the larger one. */
export function containment(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size === 0 || right.size === 0) return 0
  return overlap(left, right) / Math.min(left.size, right.size)
}

/** The source this page copies, if any: by canonical address, then by hash, then by shingles. */
export function duplicateOf(page: Fingerprint & { readonly canonical: string }, known: readonly Known[]) {
  const byAddress = known.find((item) => item.canonical === page.canonical)
  if (byAddress) return byAddress.id
  const byHash = known.find((item) => item.hash === page.hash)
  if (byHash) return byHash.id
  if (page.shingles.size < MIN_SHINGLES) return undefined
  return known.find(
    (item) =>
      item.shingles.size >= MIN_SHINGLES &&
      (jaccard(page.shingles, item.shingles) >= JACCARD || containment(page.shingles, item.shingles) >= CONTAINMENT),
  )?.id
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  return [...small].filter((shingle) => large.has(shingle)).length
}
