export * as BrainCredit from "./credit"

// Proven knowledge: what the brain learns from how runs end. A card or memory entry the agent cited, or opened with
// `get`, in a run whose checks went from failing to passing (or that the judge passed) gains weight; one cited in a
// run the user reverted loses it, and one delivered again and again but never used fades. The weight is bounded, so
// credit can reorder what recall picks but never decides it alone, and the counts halve every 90 days, so what proved
// useful long ago does not outweigh what bears on the code now.

const DAY = 24 * 60 * 60 * 1000

/** Counts halve over this long. */
export const HALF_LIFE = 90 * DAY

/** What credit may do to a candidate's value: never less than this share of it, never more. */
export const BOUNDS = { low: 0.7, high: 1.3 } as const

/** A card delivered this many times and never cited or opened starts to count as ignored. */
export const IGNORED_AFTER = 5

/** Content under this confidence is searchable but never recalled on its own, so credit never lifts it. */
export const FLOOR = 0.6

/** Weight an outcome link carries: a file a run that cited the record changed and passed. */
export const APPLIED = 0.5

export type Counts = { readonly helpful: number; readonly harmful: number; readonly ignored: number }

/** How a run that delivered knowledge ended: its checks went green (or the judge passed it), it was reverted, or neither. */
export type Outcome = "pass" | "revert" | "none"

/** `clamp(1 + 0.08·(helpful − harmful) − 0.02·min(ignored, 10), 0.7, 1.3)`. */
export function proven(counts: Counts) {
  const raw = 1 + 0.08 * (counts.helpful - counts.harmful) - 0.02 * Math.min(counts.ignored, 10)
  return Math.min(BOUNDS.high, Math.max(BOUNDS.low, raw))
}

/**
 * Credit as it applies to a candidate: held content and content under the confidence floor are never lifted by it,
 * though what the user marked wrong still weighs them down.
 */
export function lift(counts: Counts, item: { readonly confidence: number; readonly held?: boolean }) {
  const value = proven(counts)
  return item.held || item.confidence < FLOOR ? Math.min(1, value) : value
}

/** A count after `elapsed` milliseconds of its 90-day half-life. */
export function decay(count: number, elapsed: number) {
  if (count === 0 || elapsed <= 0) return count
  return count * factor(elapsed)
}

/** What every count is multiplied by after `elapsed` milliseconds. */
export function factor(elapsed: number) {
  return elapsed <= 0 ? 1 : 0.5 ** (elapsed / HALF_LIFE)
}
