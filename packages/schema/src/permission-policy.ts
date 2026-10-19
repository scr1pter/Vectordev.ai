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

/** Whether a request asks the user every time: account mutations and changes to memory's own files. */
export function requiresApproval(permission?: string, always?: readonly string[]) {
  return permission === MEMORY_SOURCE || requiresCloudApproval(permission, always)
}

export function canAutoApprove(permission?: string, always?: readonly string[]) {
  return (
    permission !== "doom_loop" &&
    permission !== "browser_sensitive" &&
    !permission?.startsWith("computer_") &&
    !requiresApproval(permission, always)
  )
}

export function canAlwaysApprove(permission?: string, always?: readonly string[]) {
  return canAutoApprove(permission, always) && Boolean(always?.length)
}
