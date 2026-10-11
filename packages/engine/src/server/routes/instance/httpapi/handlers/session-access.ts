import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { allowsSession, guestWorkspaceDirectory, type Principal } from "@vectordevai/protocol/middleware/authorization"
import { Effect } from "effect"

export function allowsSessionLocation(principal: Principal, item: Session.Info) {
  if (allowsSession(principal, item.id)) return true
  return guestWorkspaceDirectory(principal, item.workspaceID) === item.directory
}

// Records that belong to a session (its status, pending permissions, open questions) are visible to a
// guest only when the guest may open that session. Instance-wide lists would otherwise show a guest the
// owner's sessions that run in the same directory.
export function allowsSessionID(session: Session.Interface, principal: Principal, sessionID: SessionID) {
  if (allowsSession(principal, sessionID)) return Effect.succeed(true)
  return session.get(sessionID).pipe(
    Effect.map((item) => allowsSessionLocation(principal, item)),
    Effect.catch(() => Effect.succeed(false)),
  )
}
