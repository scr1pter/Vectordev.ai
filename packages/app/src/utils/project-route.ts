import { decode64 } from "@/utils/base64"

const RESERVED_TOP_LEVEL_ROUTES = new Set([
  "new-session",
  "code",
  "work",
  "parallel-workspaces",
  "cloud",
  "canvas",
  "browser-agent",
])

export function projectPathFromWorkspaceRoute(pathname: string) {
  const parts = pathname.split("/").filter(Boolean)
  if (!parts.length || parts[0] === "server" || RESERVED_TOP_LEVEL_ROUTES.has(parts[0])) return ""
  return decode64(parts[0]) ?? ""
}

export function decodeRouteSegment(value: string | undefined) {
  if (!value) return ""
  try {
    return decodeURIComponent(value)
  } catch {
    return ""
  }
}

export function sessionIDFromRouteValue(value: string | null | undefined) {
  if (!value || !value.startsWith("ses") || /[\u0000-\u001f\u007f\ufffd]/u.test(value)) return ""
  return value
}
