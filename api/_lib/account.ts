import { ApiError, type ApiRequest } from "./http.js"

export type AccountUser = {
  id: string
  email: string
  name?: string
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
  const metadata = "user_metadata" in user ? user.user_metadata : undefined
  const metadataName =
    metadata && typeof metadata === "object"
      ? "full_name" in metadata && metadata.full_name
        ? metadata.full_name
        : "name" in metadata
          ? metadata.name
          : undefined
      : undefined
  return {
    id: user.id,
    email,
    ...(typeof metadataName === "string" && metadataName.trim() ? { name: metadataName.trim() } : {}),
  }
}
