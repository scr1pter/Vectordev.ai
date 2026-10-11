// Detects when a prompt to the Vector agent is really asking for something that
// needs a database — auth, accounts, or data persistence. The shell listens for
// the "vector:db-intent" event this powers and proposes setting up a Supabase
// database for the active project: asking the agent to do it (which checks
// database_status, then links or creates one after the user confirms), or
// opening the project's Database screen in Vector Cloud. It only PROPOSES.

export const DB_INTENT_EVENT = "vector:db-intent"

export type DatabaseIntent = { matched: boolean; reason?: "auth" | "database" }

// Auth / accounts — the strongest signal that data needs to be persisted.
const AUTH_PATTERN =
  /\b(auth(?:entication|orize|orisation)?|log[- ]?in|logging in|sign[- ]?in|sign[- ]?up|signup|register(?:ing|ration)?|oauth|sso|magic link|password(?:s| reset| less)?|user accounts?|account creation|session tokens?|jwt)\b/i

// Explicit data-persistence language.
const DB_PATTERN =
  /\b(database|supabase|postgres(?:ql)?|\bsql\b|persist(?:ence)?|store (?:the )?(?:users?|data|records|profiles?)|users? table|save (?:the )?(?:users?|data|records)|\bcrud\b|db schema|prisma|drizzle)\b/i

// A prompt that already directs the agent to Vector Cloud (the database setup
// and Fix this deploy prompts) needs no proposal on top of it.
const VECTOR_CLOUD_PROMPT = /\bvector_cloud\b/

export function detectDatabaseIntent(text: string): DatabaseIntent {
  const value = (text ?? "").trim()
  if (value.length < 4 || VECTOR_CLOUD_PROMPT.test(value)) return { matched: false }
  if (AUTH_PATTERN.test(value)) return { matched: true, reason: "auth" }
  if (DB_PATTERN.test(value)) return { matched: true, reason: "database" }
  return { matched: false }
}

export function emitDatabaseIntent(text: string, directory?: string) {
  const intent = detectDatabaseIntent(text)
  if (!intent.matched) return
  globalThis.window?.dispatchEvent(
    new CustomEvent(DB_INTENT_EVENT, { detail: { reason: intent.reason, directory } }),
  )
}
