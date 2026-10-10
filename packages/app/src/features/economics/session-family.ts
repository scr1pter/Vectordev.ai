import type { Event } from "@vectordevai/sdk/v2"

type Session = { id: string; parentID?: string; directory: string; time: { updated: number } }

export function sessionFamilyEventID(event: Event) {
  if (event.type === "session.updated") return event.properties.info.parentID ? event.properties.info.id : undefined
  // The deleted child's metadata is no longer queryable, but its event retains the authoritative parent.
  if (event.type === "session.deleted") return event.properties.info.parentID
  if (
    event.type === "session.idle" ||
    event.type === "session.next.ancillary.usage" ||
    event.type === "session.next.step.ended" ||
    event.type === "session.next.compaction.ended" ||
    event.type === "session.next.compaction.failed" ||
    event.type === "session.next.message.imported" ||
    event.type === "session.next.revert.committed" ||
    event.type === "message.part.removed" ||
    event.type === "message.removed" ||
    (event.type === "message.part.updated" && event.properties.part.type === "step-finish")
  ) return event.properties.sessionID
}

// Child spend is projected into ancestors, but their idle event may already have happened.
// Resolve placement from current metadata; a cancelled child must not need to wake its parent to update cost.
export function createSessionFamilyRefresher(
  get: (sessionID: string, directory: string) => Promise<Session | undefined>,
  refresh: (sessionID: string, directory: string, revision: number) => Promise<boolean>,
) {
  const pending = new Map<string, { requested: boolean; promise: Promise<void> }>()
  const refreshed = new Map<string, number>()
  const lifecycle = { disposed: false }
  return {
    refresh(sessionID: string, directory: string) {
      if (lifecycle.disposed) return Promise.resolve()
      const key = JSON.stringify([directory, sessionID])
      const existing = pending.get(key)
      if (existing) {
        existing.requested = true
        return existing.promise
      }
      const state = { requested: true, promise: Promise.resolve() }
      pending.set(key, state)
      state.promise = (async () => {
        while (state.requested && !lifecycle.disposed) {
          state.requested = false
          const seen = new Set<string>()
          let current: string | undefined = sessionID
          let location = directory
          while (current && !seen.has(current) && !lifecycle.disposed) {
            seen.add(current)
            const session = await get(current, location)
            if (!session || lifecycle.disposed) break
            location = session.directory
            if (!session.parentID) {
              const root = JSON.stringify([location, session.id])
              const revision = session.time.updated
              if (revision > (refreshed.get(root) ?? -1)) {
                if (await refresh(session.id, location, revision))
                  refreshed.set(root, Math.max(revision, refreshed.get(root) ?? -1))
              }
              break
            }
            current = session.parentID
          }
        }
      })().finally(() => pending.delete(key))
      return state.promise
    },
    dispose() {
      lifecycle.disposed = true
      pending.clear()
      refreshed.clear()
    },
  }
}
