const passiveRendererPermissions = new Set(["clipboard-sanitized-write", "notifications"])

export function allowsRendererPermission(permission: string, mediaType?: string) {
  if (passiveRendererPermissions.has(permission)) return true
  return permission === "media" && mediaType === "audio"
}

export function allowsRendererPermissionRequest(permission: string, mediaTypes?: readonly string[]) {
  if (passiveRendererPermissions.has(permission)) return true
  if (permission !== "media") return false
  return mediaTypes?.length === 1 && mediaTypes[0] === "audio"
}
