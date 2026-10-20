export * as BrainFuse from "./fuse"

// How the brain's retrieval channels become one ranking. Each channel ranks what it finds (keywords over memory, keywords
// over documents, code links, and meaning once the local search model is downloaded), weighted reciprocal rank fusion
// merges the rankings without comparing their raw scores, and a gate keeps out what no channel found convincingly, so
// an unrelated request recalls nothing at all.

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

/**
 * `fused(i) = Σ weight × strength(i) / (K + rank)` over the top `DEPTH` of each list, rank from 1. A list may say how
 * strongly it holds each id (code-link activation does: a record a touched file defines is not one a hop away), and
 * an id without one counts fully.
 */
export function rrf(
  lists: readonly {
    readonly weight: number
    readonly ids: readonly string[]
    readonly strength?: ReadonlyMap<string, number>
  }[],
  k = K,
) {
  const fused = new Map<string, number>()
  for (const list of lists)
    for (const [index, id] of list.ids.slice(0, DEPTH).entries())
      fused.set(id, (fused.get(id) ?? 0) + (list.weight * (list.strength?.get(id) ?? 1)) / (k + index + 1))
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

/**
 * What the request is touching: a file it edits, reads or attaches, or a symbol it names, with how strongly. Edited and
 * attached files count most, the working tree's changes and named symbols next, files only read least.
 */
export type Seed = { readonly path?: string; readonly symbol?: string; readonly weight: number }

/** At most this many seeds start activation. */
export const SEEDS = 12

/** Seed weights by how the request touches a file or symbol. */
export const SEED = { edited: 1, attached: 1, symbol: 0.9, changed: 0.8, read: 0.7 } as const

/** How much a link to a file still says, by what became of its line. */
export const FRESHNESS = { fresh: 1, drifted: 0.7, missing: 0.4 } as const

/** Activation a candidate needs to be eligible on code links alone. */
export const ACTIVATED = 0.4

/** Weight of code-link activation in fusion, when the seeds are the request's own working set. */
export const GRAPH = 1.2

/** Weight of the search by meaning in fusion; when the model is not ready its list is empty, so it weighs nothing. */
export const DENSE = 1

export type Link = {
  readonly owner: string
  readonly path: string
  readonly symbol?: string
  /** The link's weight by how it was found (BrainAnchor.WEIGHT). */
  readonly weight: number
  readonly status: keyof typeof FRESHNESS
}

/**
 * Spreading activation over code links: `a = 1 − Π(1 − seed × link × freshness)` over each seed that touches a linked
 * file or names a linked symbol. A record linked to two touched files, or by a definition, is more active than one
 * linked to a single file a request only read.
 */
export function activation(seeds: readonly Seed[], links: readonly Link[]) {
  const rest = new Map<string, number>()
  for (const seed of seeds.slice(0, SEEDS))
    for (const link of links) {
      if (!(seed.path !== undefined && seed.path === link.path) && !(seed.symbol !== undefined && seed.symbol === link.symbol))
        continue
      rest.set(link.owner, (rest.get(link.owner) ?? 1) * (1 - seed.weight * link.weight * FRESHNESS[link.status]))
    }
  return new Map([...rest].map(([owner, remaining]) => [owner, 1 - remaining]))
}

/**
 * One hop from what activation reached: records of the same passage at half, of the same section at a quarter, and a
 * term the document defines at 0.3 of a seed whose path names it. An item keeps the most it is given.
 */
export function spread(
  active: ReadonlyMap<string, number>,
  items: readonly { readonly id: string; readonly passage?: string; readonly section?: string; readonly term?: string }[],
  seeds: readonly Seed[],
) {
  const out = new Map(active)
  const raise = (id: string, value: number) => out.set(id, Math.max(out.get(id) ?? 0, value))
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const [id, value] of active) {
    const source = byId.get(id)
    if (!source) continue
    for (const item of items) {
      if (item.id === id) continue
      if (source.passage !== undefined && item.passage === source.passage) raise(item.id, value * 0.5)
      else if (source.section !== undefined && item.section === source.section) raise(item.id, value * 0.25)
    }
  }
  for (const seed of seeds.slice(0, SEEDS)) {
    const words = seed.path?.toLowerCase().split(/[/._-]/) ?? []
    for (const item of items)
      if (item.term && item.term.length >= 3 && words.includes(item.term.toLowerCase())) raise(item.id, 0.3 * seed.weight)
  }
  return out
}

// House vocabulary: the repository's own words for things. A glossary or acronym record says two phrases mean one
// thing ("SLO" and "service level objective"), so a request that uses one also searches for the other, at half the
// weight of its own words. A definition longer than a name is prose, not another name, so it never expands a query.

/** One thing the repository names more than one way, each name as the terms it searches for. */
export type Word = { readonly phrases: readonly (readonly string[])[] }

/** The vocabulary a query is expanded with: terms added at this weight, at most this many per query. */
export const VOCABULARY = { weight: 0.5, terms: 8, phrase: 4 } as const

/** Words from term records' fields: the term, its aliases, and a definition short enough to be another name for it. */
export function vocabulary(
  records: readonly { readonly term?: unknown; readonly aliases?: unknown; readonly definition?: unknown }[],
  terms: (text: string) => ReadonlyMap<string, number>,
): Word[] {
  return records.flatMap((record) => {
    const names = [
      record.term,
      ...(Array.isArray(record.aliases) ? record.aliases : []),
      record.definition,
    ].filter((name): name is string => typeof name === "string")
    const phrases = names
      .map((name) => [...terms(name).keys()])
      .filter((phrase) => phrase.length > 0 && phrase.length <= VOCABULARY.phrase)
    const distinct = phrases.filter(
      (phrase, index) => phrases.findIndex((other) => other.join(" ") === phrase.join(" ")) === index,
    )
    return distinct.length >= 2 ? [{ phrases: distinct }] : []
  })
}

/**
 * A query with the repository's other names for what it names: each phrase of a word whose every term the query has
 * brings in the word's other phrases at `VOCABULARY.weight`. `phrases` are the ones brought in, so a match on a whole
 * phrase counts as one matched term of the query (see `hits`).
 */
export function expand(query: ReadonlyMap<string, number>, words: readonly Word[]) {
  const out = new Map(query)
  const phrases: (readonly string[])[] = []
  for (const word of words) {
    if (!word.phrases.some((phrase) => phrase.every((term) => query.has(term)))) continue
    for (const phrase of word.phrases) {
      if (phrase.every((term) => query.has(term))) continue
      const fresh = phrase.filter((term) => !out.has(term))
      if (out.size + fresh.length - query.size > VOCABULARY.terms) continue
      for (const term of fresh) out.set(term, VOCABULARY.weight)
      phrases.push(phrase)
    }
  }
  return { query: out, phrases }
}

/**
 * How many of a query's own terms an item matched, where a phrase the vocabulary brought in counts as one term when the
 * item has all of it: "service level objective" in an item answers a query for "SLO", "service level agreement" does
 * not.
 */
export function hits(matched: readonly string[], query: ReadonlyMap<string, number>, phrases: readonly (readonly string[])[]) {
  const own = matched.filter((term) => query.has(term)).length
  const found = new Set(matched)
  return own + phrases.filter((phrase) => phrase.length > 0 && phrase.every((term) => found.has(term))).length
}
