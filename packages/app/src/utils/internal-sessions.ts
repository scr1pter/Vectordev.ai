// Sessions Vector creates for its own tools (browser agent planner, codespace
// architect). They must stay OUT of every
// user-visible session list while remaining real engine sessions.
export const INTERNAL_SESSION_TITLE_PREFIX = "Vector Tool · "
// Vectorscope's reviewer sessions, from the desktop panel and from `vector review`. Their findings, progress, cost
// and tokens belong to the review panel, so the sessions themselves never open, list or notify like a task.
export const REVIEW_SESSION_TITLE_PREFIX = "Vectorscope review · "

export function isInternalSession(session: { title?: string | null } | undefined | null): boolean {
  const title = session?.title ?? ""
  return title.startsWith(INTERNAL_SESSION_TITLE_PREFIX) || title.startsWith(REVIEW_SESSION_TITLE_PREFIX)
}
