export function safeExternalUrl(input: string, base?: string) {
  try {
    const url = new URL(input, base)
    if (url.protocol !== "https:" && url.protocol !== "http:") return
    if (url.username || url.password) return
    return url.toString()
  } catch {
    return
  }
}

export function openExternalUrl(input: string, open: typeof window.open = window.open.bind(window)) {
  const url = safeExternalUrl(input)
  if (!url) return false
  const next = open(url, "_blank", "noopener,noreferrer")
  if (next) next.opener = null
  return true
}

export function secureExternalAnchor(anchor: HTMLAnchorElement, base: string) {
  const href = safeExternalUrl(anchor.getAttribute("href") ?? "", base)
  if (!href) return false
  anchor.href = href
  anchor.target = "_blank"
  anchor.rel = "noopener noreferrer"
  return true
}
