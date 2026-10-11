// Static UI assets fetched through router-authenticated test or legacy route
// trees. The production UI fallback is public so it can bootstrap credentials
// from a URL fragment; typed APIs and /doc keep their own auth layers.
export const PUBLIC_UI_PATHS = new Set<string>([
  "/site.webmanifest",
  "/web-app-manifest-192x192.png",
  "/web-app-manifest-512x512.png",
])

export function isPublicUIPath(method: string, pathname: string) {
  return method === "GET" && PUBLIC_UI_PATHS.has(pathname)
}
