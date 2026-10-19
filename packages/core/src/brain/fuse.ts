export * as BrainFuse from "./fuse"

// How the brain's retrieval channels become one ranking. Each channel ranks what it finds (keywords over memory, keywords
// over documents; code links and meaning in later releases), weighted reciprocal rank fusion merges the rankings without
// comparing their raw scores, and a gate keeps out what no channel found convincingly, so an unrelated request recalls
// nothing at all.

/** RRF's constant: how quickly the credit for a lower rank falls off. */
export const K = 60

/** Each channel contributes its top this many. */
export const DEPTH = 50

/** How much a source is trusted, before anything about the request. */
export const TRUST = {
  /** What the user wrote: their rules, MEMORY.md and saved memory, and a mirrored file. */
  user: 1,
  /** What the agent learned (checked evidence or not, the user can undo it). */
  learned: 0.95,
  /** A document the user added (Settings, the CLI, a chat attachment). */
  document: 0.85,
  /** A doc the repository tracks. */
  repository: 0.8,
  /** Records a model found, quote-locked. */
  distilled: 0.7,
} as const

/** `fused(i) = Σ weight / (K + rank)` over the top `DEPTH` of each list, rank from 1. */
export function rrf(lists: readonly { readonly weight: number; readonly ids: readonly string[] }[], k = K) {
  const fused = new Map<string, number>()
  for (const list of lists)
    for (const [index, id] of list.ids.slice(0, DEPTH).entries())
      fused.set(id, (fused.get(id) ?? 0) + list.weight / (k + index + 1))
  return fused
}

/**
 * Whether a keyword match is a topic rather than noise: two shared terms, or the only term of a short query. One shared
 * word in a long request is how unrelated text overlaps.
 */
export function eligible(matched: number, terms: number) {
  return matched >= 2 || (terms <= 2 && matched >= 1)
}

/** A candidate's worth to a request: its fused rank against the best, times how far it can be relied on. */
export function value(input: {
  readonly fused: number
  readonly best: number
  readonly trust: number
  readonly freshness: number
  readonly proven: number
  readonly confidence: number
}) {
  if (input.best <= 0) return 0
  return (input.fused / input.best) * input.trust * input.freshness * input.proven * input.confidence
}
