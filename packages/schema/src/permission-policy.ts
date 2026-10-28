export * as PermissionPolicy from "./permission-policy"

const CLOUD_WRITES = new Set([
  "vector_cloud_publish",
  "vector_cloud_database",
  "vector_cloud_environment",
  "vector_cloud_hosting",
])

// Account mutations must ask again even when configuration or a client normally auto-accepts tools.
export function requiresCloudApproval(permission?: string, always?: readonly string[]) {
  return Boolean(
    permission && (CLOUD_WRITES.has(permission) || (permission.startsWith("vector_cloud_") && !always?.length)),
  )
}

/**
 * A change to a file Vector's memory is read from (RULES.md, BRAIN.md, MEMORY.md) by a session that took in outside
 * content. A line there binds every later request, so planted text must never land in one unseen: it asks every time,
 * whatever configuration allows or a client auto-accepts.
 */
export const MEMORY_SOURCE = "memory_source"

/**
 * Keeping a research run makes its report, written from web pages, recallable by every later request. A page can carry
 * planted instructions, so the agent keeps research only after the user says yes: it asks every time, whatever
 * configuration allows or a client auto-accepts.
 */
export const RESEARCH_KEEP = "research_keep"

/**
 * A shell command that may reach the network while Vector Local is on. Vector cannot see where such a command
 * connects, so it asks every time, whatever configuration allows or a client auto-accepts.
 */
export const NETWORK_COMMAND = "network_command"

/** Why a network command asks, as the ask shows it. */
export const NETWORK_COMMAND_REASON =
  "Vector Local is on, and this command may connect to the network. Vector cannot see where it connects."

/**
 * The pattern prefix of a web address the agent chose after the conversation read the web, while Vector Local is on
 * (`after-web https://…`). A page can steer the agent into putting the user's data in an address, so it asks every
 * time: no saved "Always allow" for a site matches it, and neither configuration nor auto-accept answers it.
 */
export const AFTER_WEB = "after-web "

/** Why an address after the web asks, as the ask shows it. */
export const AFTER_WEB_REASON =
  "This conversation read the web, and this address is new: neither you nor an earlier result gave it. A page can steer the agent into putting your data in an address."

/**
 * Computer permissions (Vector Hands; internal ids stay `computer_*`). Whenever one is raised, a person answers it:
 * no configuration allow, `"*": "allow"` default, auto-accept or company allow does, and a `deny` still wins.
 * `computer_app` is the per-app ask, the only one that may be saved as Always allow, and only for `app:` keys; the
 * desktop, never the engine, keeps that saved list. `computer_sensitive` asks before each risky step and never
 * offers Always. `computer_observe` and `computer_interact` are copy keys only and are never raised.
 */
export const COMPUTER_APP = "computer_app"
export const COMPUTER_OBSERVE = "computer_observe"
export const COMPUTER_INTERACT = "computer_interact"
export const COMPUTER_SENSITIVE = "computer_sensitive"
/** The prefix of an app key (`app:macos:<bundleId>`, `app:windows:…`), the only pattern a computer Always may save. */
export const COMPUTER_APP_PREFIX = "app:"
/** Why typing an address, recipient or number the user never gave asks once the screen has been read. */
export const AFTER_SCREEN_REASON =
  "Text on your screen can steer the agent, and this address or recipient is new: you did not give it."
/** Why a step asks when text on screen reads as instructions to an AI. */
export const FLAGGED_SCREEN_REASON =
  "Text on screen looks like instructions to an AI. Check that this step is what you asked for."

// A saved computer approval names one concrete app: a wildcard such as `app:*` or `app:macos:*` is never one.
const concreteAppKey = (pattern: string) =>
  pattern.length > COMPUTER_APP_PREFIX.length && pattern.startsWith(COMPUTER_APP_PREFIX) && !/[*?]/.test(pattern)

/**
 * Whether a request asks the user every time: account mutations, changes to memory's own files, keeping research, the asks Vector
 * Local adds for the agent's network commands and its new addresses after the web, and every computer permission.
 */
export function requiresApproval(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return (
    Boolean(permission?.startsWith("computer_")) ||
    permission === MEMORY_SOURCE ||
    permission === RESEARCH_KEEP ||
    permission === NETWORK_COMMAND ||
    Boolean(patterns?.some((pattern) => pattern.startsWith(AFTER_WEB))) ||
    requiresCloudApproval(permission, always)
  )
}

export function canAutoApprove(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return (
    permission !== "doom_loop" &&
    permission !== "browser_sensitive" &&
    !permission?.startsWith("computer_") &&
    !requiresApproval(permission, always, patterns)
  )
}

/**
 * Whether a reply may be "always". `computer_app` qualifies only when every saved pattern is a concrete `app:` key, even
 * though it never auto-approves; every other computer permission never qualifies.
 */
export function canAlwaysApprove(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  if (permission === COMPUTER_APP) return Boolean(always?.length) && always!.every(concreteAppKey)
  return canAutoApprove(permission, always, patterns) && Boolean(always?.length)
}
