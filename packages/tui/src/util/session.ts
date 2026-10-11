import type { Session } from "@vectordevai/sdk/v2"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export function isInternalSession(session: Pick<Session, "internal" | "title"> | undefined) {
  return Boolean(
    session?.internal ||
      session?.title.startsWith("Vector Tool · ") ||
      session?.title.startsWith("Vectorscope review · "),
  )
}

// Helpers are absent from list snapshots after reconnect. Resolve an unknown session before showing any attention
// surface; a failed lookup cannot prove that it is a user session. Known sessions keep synchronous notification order.
export function notifyVisibleSession(input: {
  sessionID?: string
  cached: (sessionID: string) => Session | undefined
  read: (sessionID: string) => Promise<Session | undefined>
  show: (session: Session | undefined) => void
}) {
  if (!input.sessionID) return input.show(undefined)
  const cached = input.cached(input.sessionID)
  if (cached) {
    if (!isInternalSession(cached)) input.show(cached)
    return
  }
  return input
    .read(input.sessionID)
    .then((session) => {
      if (session && !isInternalSession(session)) input.show(session)
    })
    .catch(() => undefined)
}
