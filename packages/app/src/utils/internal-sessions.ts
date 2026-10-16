// Sessions Vector runs for its own helpers: Vectorscope reviews and their double-check, inline edit, autocomplete,
// the browser agent and swarm planners. The engine marks them with `internal` (the helper's name) and leaves them out
// of session lists. They must stay out of everything the user navigates — lists, search, tabs, notifications — while
// their spend still counts, towards the session that launched them when there is one.
export const REVIEW_SESSION_TITLE_PREFIX = "Vectorscope review · "

const LEGACY_TITLE_PREFIXES = ["Vector Tool · ", "Vectorscope review · "]
// Before Vectorscope had its name, the desktop titled reviewers "Vector review · #12 · review" (1.99.8) or "Vecbot
// review · #12 · review", and `vector review` put the seven-character commit in the middle. Only that middle counts,
// so a session the user titled "Vector review · login · review" stays visible.
const EARLY_REVIEW_TITLE = /^(Vector|Vecbot) review · (#\d+|[0-9a-f]{7}) · (review|security|verify)$/

export function isInternalSession(session: { internal?: string; title?: string | null } | undefined | null) {
  if (!session) return false
  if (session.internal) return true
  // An engine that predates the marker only knows these sessions by the titles Vector gave them.
  const title = session.title ?? ""
  return LEGACY_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix)) || EARLY_REVIEW_TITLE.test(title)
}

const HELPER_LABELS: Record<string, string> = {
  vectorscope: "Vectorscope review",
  "codespace.edit": "Inline edit",
  "codespace.autocomplete": "Autocomplete",
  "browser-agent": "Browser Agent planner",
  swarm: "Swarm planner",
}

// What the user calls the helper behind a session's `internal` name, e.g. "vectorscope.verify" is part of a
// Vectorscope review.
export function helperLabel(internal: string) {
  return HELPER_LABELS[internal] ?? HELPER_LABELS[internal.split(".")[0] ?? ""] ?? "Vector helper"
}
