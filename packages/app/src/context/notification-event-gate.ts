import { isInternalSession } from "@/utils/internal-sessions"

export function createNotificationEventGate(limit = 500) {
  const seen = new Set<string>()

  return (id?: string) => {
    if (!id) return true
    if (seen.has(id)) return false

    seen.add(id)
    if (seen.size <= limit) return true

    const oldest = seen.values().next().value
    if (oldest) seen.delete(oldest)
    return true
  }
}

export function sessionNotificationAllowed(
  sessionID: string | undefined,
  session: { internal?: string; parentID?: string; title?: string | null } | undefined,
) {
  // Global errors have no session to resolve. Session errors must establish visibility before making noise:
  // reconnect lookups can fail for a hidden helper, whose result belongs only to the surface that launched it.
  if (!sessionID) return true
  return Boolean(session && !session.parentID && !isInternalSession(session))
}
