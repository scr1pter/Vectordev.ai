// Sessions Vector creates for its own tools (browser agent planner, codespace
// architect). They must stay OUT of every
// user-visible session list while remaining real engine sessions.
export const INTERNAL_SESSION_TITLE_PREFIX = "Vector Tool · "

export function isInternalSession(session: { title?: string | null } | undefined | null): boolean {
  return Boolean(session?.title?.startsWith(INTERNAL_SESSION_TITLE_PREFIX))
}
