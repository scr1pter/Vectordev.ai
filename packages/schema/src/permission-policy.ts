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
 * Whether a request asks the user every time: account mutations, changes to memory's own files, keeping research, and the asks Vector
 * Local adds for the agent's network commands and its new addresses after the web.
 */
export function requiresApproval(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return (
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

export function canAlwaysApprove(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return canAutoApprove(permission, always, patterns) && Boolean(always?.length)
}
