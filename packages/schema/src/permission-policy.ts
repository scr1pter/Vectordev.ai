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
 * An edit to a file Vector reads into an agent's system prompt or permissions. It asks every time, whatever
 * configuration allows or a client auto-accepts.
 */
export const PROMPT_SOURCE = "prompt_source"

/**
 * A shell command that removes or overrides the marker Vector puts on every program its agents start, which Vector's
 * owner-only commands (`vector memory skills approve`, `vector trust prompts approve`) refuse under: run without it,
 * one would act as the owner. It asks every time, whatever configuration allows or a client auto-accepts.
 */
export const AGENT_MARKER = "agent_marker"

/** Why a command that drops the agent marker asks, as the ask shows it. */
export const AGENT_MARKER_REASON =
  "This command removes the marker that stops Vector's agents from running owner-only commands, such as approving learned skills or prompt files."

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
 * Whether a request asks the user every time: account mutations, changes to memory's own files and to the files
 * Vector's prompts are read from, commands that drop the agent marker, and the asks Vector Local adds for the agent's
 * network commands and its new addresses after the web.
 */
export function requiresApproval(permission?: string, always?: readonly string[], patterns?: readonly string[]) {
  return (
    permission === MEMORY_SOURCE ||
    permission === PROMPT_SOURCE ||
    permission === AGENT_MARKER ||
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
