import type { ModelOutcome } from "./economics-types"

// An unavailable read leaves the previous sample alone. A successful read
// without an attributable outcome removes an obsolete single-model sample.
export function createSessionOutcomeRecorder(input: {
  load: (projectId: string, sessionID: string) => Promise<{ outcome?: ModelOutcome } | undefined>
  save: (projectId: string, sessionID: string, outcome?: ModelOutcome) => Promise<void>
}) {
  const pending = new Map<string, { dirty: boolean; promise: Promise<void> }>()
  let disposed = false

  const refresh = (projectId: string, sessionID: string): Promise<void> => {
    if (disposed) return Promise.resolve()
    const key = JSON.stringify([projectId, sessionID])
    const current = pending.get(key)
    if (current) {
      current.dirty = true
      return current.promise
    }
    const state = { dirty: true, promise: Promise.resolve() }
    pending.set(key, state)
    state.promise = Promise.resolve()
      .then(async () => {
        while (state.dirty && !disposed) {
          state.dirty = false
          const result = await input.load(projectId, sessionID)
          if (result && !disposed) await input.save(projectId, sessionID, result.outcome)
        }
      })
      .finally(() => pending.delete(key))
    return state.promise
  }

  return {
    refresh,
    dispose: () => {
      disposed = true
    },
  }
}
