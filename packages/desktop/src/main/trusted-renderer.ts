type RendererEvent = {
  sender: {
    isDestroyed: () => boolean
    getURL: () => string
  }
  senderFrame?: { url: string } | null
}

export function isTrustedRendererEvent<T extends RendererEvent>(
  event: T,
  checks: {
    windowFor: (contents: T["sender"]) => unknown
    trustedUrl: (url?: string) => boolean
  },
) {
  if (event.sender.isDestroyed() || !checks.windowFor(event.sender)) return false
  return checks.trustedUrl(event.senderFrame?.url ?? event.sender.getURL())
}
