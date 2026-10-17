import { ApiError, type ApiRequest } from "./http.js"

export type AccountUser = {
  id: string
  email: string
  name?: string
  avatar?: string
}

function accountConfiguration() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? process.env.SUPABASE_ANON_KEY?.trim() ?? ""
  return { url, publishableKey, available: Boolean(url && publishableKey) }
}

export function publicAccountConfiguration() {
  return accountConfiguration()
}

function bearerToken(request: Pick<ApiRequest, "headers">) {
  const value = request.headers.authorization
  const header = Array.isArray(value) ? value[0] : value
  return /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "")?.[1]?.trim()
}

export async function requireAccountUser(
  request: Pick<ApiRequest, "headers">,
  fetcher: typeof fetch = fetch,
): Promise<AccountUser> {
  const configuration = accountConfiguration()
  if (!configuration.available) {
    throw new ApiError(503, "ACCOUNT_NOT_CONFIGURED", "Vector accounts are temporarily unavailable.")
  }
  const token = bearerToken(request)
  if (!token) throw new ApiError(401, "SIGN_IN_REQUIRED", "Sign in to continue.")

  const response = await fetcher(`${configuration.url}/auth/v1/user`, {
    headers: {
      apikey: configuration.publishableKey,
      authorization: `Bearer ${token}`,
    },
  })
  if (!response.ok) throw new ApiError(401, "SESSION_INVALID", "Your session expired. Sign in again.")
  const user: unknown = await response.json()
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    typeof user.id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(user.id) ||
    !("email" in user) ||
    typeof user.email !== "string"
  ) {
    throw new ApiError(401, "SESSION_INVALID", "Your session expired. Sign in again.")
  }
  const email = user.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(401, "SESSION_INVALID", "Your session expired. Sign in again.")
  }
  if (
    !("email_confirmed_at" in user) ||
    typeof user.email_confirmed_at !== "string" ||
    !Number.isFinite(Date.parse(user.email_confirmed_at))
  ) {
    throw new ApiError(403, "EMAIL_NOT_CONFIRMED", "Confirm your email address before continuing.")
  }
  return { id: user.id, email, ...accountProfile("user_metadata" in user ? user.user_metadata : undefined) }
}

/**
 * The account's current name and photo, read with the service role key, which never leaves this server. The
 * desktop asks for them so a sign-in saved before either was carried still shows them without signing in again.
 */
export async function readAccountProfile(id: string, fetcher: typeof fetch = fetch) {
  const unavailable = new ApiError(503, "PROFILE_UNAVAILABLE", "Your Vector profile is temporarily unavailable.")
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "") ?? ""
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  const origin = URL.parse(url)
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    origin?.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
  if (
    !key ||
    !origin ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    (origin.protocol !== "https:" && !local)
  )
    throw unavailable
  const response = await fetcher(`${url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) await response?.body?.cancel().catch(() => undefined)
  // The token outlived its account.
  if (response?.status === 404) throw new ApiError(401, "CLI_TOKEN_INVALID", "Sign in to Vector again to continue.")
  if (!response?.ok) throw unavailable
  const user: unknown = await response.json().catch(() => undefined)
  if (!user || typeof user !== "object" || !("id" in user) || user.id !== id) throw unavailable
  return accountProfile("user_metadata" in user ? user.user_metadata : undefined)
}

/** Display-only name and photo from Supabase user metadata. Anything odd is left out; it never fails a request. */
export function accountProfile(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return {}
  const name =
    "full_name" in metadata && metadata.full_name ? metadata.full_name : "name" in metadata ? metadata.name : undefined
  const avatar = accountAvatar(
    "avatar_url" in metadata && metadata.avatar_url
      ? metadata.avatar_url
      : "picture" in metadata
        ? metadata.picture
        : undefined,
  )
  return {
    ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
    ...(avatar ? { avatar } : {}),
  }
}

/**
 * A profile photo the desktop may download: https on Google's avatar hosts only. People can edit their own
 * metadata, and other googleusercontent.com names (reverse DNS for cloud VMs, for one) reach servers anyone can
 * run, so the list stays this narrow.
 */
export function accountAvatar(value: unknown) {
  if (typeof value !== "string" || value.length > 2_048) return undefined
  const url = URL.parse(value.trim())
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^lh\d\.googleusercontent\.com$/.test(url.hostname)
  )
    return undefined
  return url.href
}
