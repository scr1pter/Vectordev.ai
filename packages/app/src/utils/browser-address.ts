const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/.*)?$/i
const IPV4_HOST = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/
const DOMAIN_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i

export function resolveBrowserAddress(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return "http://localhost:5173"
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (LOCAL_HOST.test(trimmed) || IPV4_HOST.test(trimmed)) return `http://${trimmed}`
  if (!/\s/.test(trimmed) && DOMAIN_HOST.test(trimmed)) return `https://${trimmed}`
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

export function selectUnambiguousPreviewUrl(results: { candidate: string; ok: boolean }[]) {
  const live = results.filter((result) => result.ok)
  if (live.length !== 1) return
  return live[0]!.candidate
}
