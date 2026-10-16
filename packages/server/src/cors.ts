import { Context } from "effect"

export type CorsOptions = {
  readonly cors?: ReadonlyArray<string>
  /**
   * Whether any http page on this machine counts as a trusted origin. Defaults to true, but a listener without a
   * password turns it off unless asked: it would run whatever another local page (a repository's dev server, say)
   * sends it, so it trusts only its own origin, the app's origins, and the `cors` list.
   */
  readonly loopbackOrigins?: boolean
}

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@vector/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  if (url.username || url.password) return false
  const loopback =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname === "[::1]")
  if (loopback && opts?.loopbackOrigins !== false) return true
  if (input === "oc://renderer") return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  // No website is trusted by default, Vector's own included: any script on it could otherwise drive a server that has
  // no password, or replay credentials a browser cached for one that has. A hosted page that needs a server is added
  // with --cors.
  return opts?.cors?.includes(input) ?? false
}

export function isAllowedRequestOrigin(input: string | undefined, host: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (host && sameHost(input, host)) return true
  return isAllowedCorsOrigin(input, opts)
}

function sameHost(origin: string, host: string) {
  try {
    const url = new URL(origin)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.host === host
    )
  } catch {
    return false
  }
}
