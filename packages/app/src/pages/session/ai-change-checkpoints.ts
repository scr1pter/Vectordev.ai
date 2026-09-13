// AI change checkpoints carry whole-file snapshots, and localStorage's small
// per-origin quota is shared with every other setting the app saves. An
// unbounded list filled it (QuotaExceededError), after which nothing else in
// the app could save either. So the list is kept newest first within a size
// budget, and a write that still does not fit falls back to smaller budgets and
// finally to checkpoint metadata without snapshots.

export const CHECKPOINT_MAX = 80
export const CHECKPOINT_BUDGET = 2_000_000

type Checkpoint = { snapshots?: unknown }

/** Newest-first checkpoints that fit `budget` characters of JSON; the newest is always kept. */
export function fitCheckpoints<T extends Checkpoint>(list: readonly T[], budget: number, max = CHECKPOINT_MAX): T[] {
  const kept: T[] = []
  let size = 2
  for (const item of list.slice(0, max)) {
    const next = JSON.stringify(item).length + 1
    if (kept.length > 0 && size + next > budget) break
    kept.push(item)
    size += next
  }
  return kept
}

/** Saves the list without ever throwing. Returns false only when even metadata could not be stored. */
export function saveCheckpoints<T extends Checkpoint>(
  storage: Pick<Storage, "setItem">,
  key: string,
  list: readonly T[],
  budget = CHECKPOINT_BUDGET,
) {
  const attempts = [
    () => fitCheckpoints(list, budget),
    () => fitCheckpoints(list, Math.floor(budget / 4)),
    // Keeps the history visible; these checkpoints can no longer restore files.
    () => list.slice(0, CHECKPOINT_MAX).map(({ snapshots: _snapshots, ...rest }) => rest),
  ]
  for (const attempt of attempts) {
    try {
      storage.setItem(key, JSON.stringify(attempt()))
      return true
    } catch {
      // Over quota: try a smaller payload.
    }
  }
  return false
}
