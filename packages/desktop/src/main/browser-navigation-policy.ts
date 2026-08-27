export function isLocalBrowserUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const host = url.hostname.toLowerCase()
    return (
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".localhost")
    )
  } catch {
    return false
  }
}

export function browserOrigin(rawUrl: string) {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.origin
  } catch {
    return
  }
}

export function isAllowedBrowserNavigation(rawUrl: string, allowedExternalOrigins: ReadonlySet<string>) {
  if (isLocalBrowserUrl(rawUrl)) return true
  const origin = browserOrigin(rawUrl)
  return Boolean(origin && allowedExternalOrigins.has(origin))
}
