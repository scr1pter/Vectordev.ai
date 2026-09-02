import { createClient, type SupabaseClient } from "@supabase/supabase-js"

let client: Promise<SupabaseClient> | undefined
const RETURN_PATH_KEY = "vector-account-return-path"

export function vectorAccountClient() {
  if (client) return client
  client = fetch("/api/auth/config", { headers: { accept: "application/json" } })
    .then(readAccountConfiguration)
    .then((configuration) => {
      return createClient(configuration.url, configuration.publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          // The /account page owns the PKCE exchange. Enabling URL detection
          // here would race that explicit exchange and consume the one-use code.
          detectSessionInUrl: false,
          flowType: "pkce",
        },
      })
    })
    .catch((cause) => {
      client = undefined
      throw cause
    })
  return client
}

export async function readAccountConfiguration(response: Response) {
  const configuration = await jsonPayload(response)
  if (
    !response.ok ||
    !configuration ||
    typeof configuration !== "object" ||
    !("available" in configuration) ||
    configuration.available !== true ||
    !("url" in configuration) ||
    typeof configuration.url !== "string" ||
    !configuration.url.trim() ||
    !("publishableKey" in configuration) ||
    typeof configuration.publishableKey !== "string" ||
    !configuration.publishableKey.trim()
  ) {
    throw new Error("Vector accounts are temporarily unavailable.")
  }
  return { url: configuration.url.trim().replace(/\/+$/, ""), publishableKey: configuration.publishableKey.trim() }
}

export async function readAccountApiResponse(response: Response, fallback: string) {
  const payload = await jsonPayload(response)
  if (!isRecord(payload)) throw new Error(fallback)
  if (!response.ok) {
    const detail = "error" in payload ? payload.error : undefined
    const message = detail && typeof detail === "object" && "message" in detail ? detail.message : undefined
    throw new Error(typeof message === "string" && message.trim() ? message : fallback)
  }
  return payload
}

export function safeReturnPath(value: string | null | undefined, fallback = "/account") {
  if (!value?.startsWith("/")) return fallback
  try {
    const base = new URL("https://vectordev.ai")
    const destination = new URL(value, base)
    if (destination.origin !== base.origin) return fallback
    return `${destination.pathname}${destination.search}${destination.hash}`
  } catch {
    return fallback
  }
}

export function rememberAccountReturnPath(value: string | null | undefined) {
  try {
    sessionStorage.setItem(RETURN_PATH_KEY, safeReturnPath(value))
  } catch {
    // Authentication should still work when browser privacy settings disable storage.
  }
}

export function takeAccountReturnPath() {
  try {
    const value = safeReturnPath(sessionStorage.getItem(RETURN_PATH_KEY))
    sessionStorage.removeItem(RETURN_PATH_KEY)
    return value
  } catch {
    return "/account"
  }
}

async function jsonPayload(response: Response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return undefined
  const payload: unknown = await response.json().catch(() => undefined)
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
