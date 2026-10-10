import { Context } from "effect"

export type CorsOptions = { readonly cors?: ReadonlyArray<string> }

export const CorsConfig = Context.Reference<CorsOptions | undefined>("@vector/ServerCorsConfig", {
  defaultValue: () => undefined,
})

export function isAllowedCorsOrigin(input: string | undefined, opts?: CorsOptions) {
  if (!input) return true
  if (!URL.canParse(input)) return false
  const url = new URL(input)
  if (url.username || url.password) return false
  if (url.protocol === "http:" && url.hostname === "localhost") return true
  if (url.protocol === "http:" && /^127\.\d+\.\d+\.\d+$/.test(url.hostname)) return true
  if (url.protocol === "http:" && url.hostname === "[::1]") return true
  if (input === "oc://renderer") return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (input === "https://vectordev.ai") return true
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
