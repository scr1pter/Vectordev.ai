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

export function canAutoApprove(permission?: string, always?: readonly string[]) {
  return (
    permission !== "doom_loop" &&
    permission !== "browser_sensitive" &&
    !permission?.startsWith("computer_") &&
    !requiresCloudApproval(permission, always)
  )
}

export function canAlwaysApprove(permission?: string, always?: readonly string[]) {
  return canAutoApprove(permission, always) && Boolean(always?.length)
}
