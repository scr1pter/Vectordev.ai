export function canAutoApprovePermission(permission: string) {
  return permission !== "doom_loop" && permission !== "browser_sensitive" && !permission.startsWith("computer_")
}

export function canAlwaysAllowPermission(permission: string, always: readonly string[]) {
  return permission !== "browser_sensitive" && !permission.startsWith("computer_") && always.length > 0
}
