export type CloudProviderId = "vercel" | "netlify" | "supabase"

type CloudFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function providerLabel(provider: CloudProviderId) {
  if (provider === "vercel") return "Vercel"
  if (provider === "netlify") return "Netlify"
  return "Supabase"
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = Reflect.get(value, key)
  return typeof field === "string" && field ? field : undefined
}

async function providerJson(token: string, url: string, request: CloudFetch): Promise<unknown> {
  const response = await request(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "user-agent": "Vector-Desktop/1",
    },
    signal: AbortSignal.timeout(20_000),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (response.ok) return body
  throw new Error(
    stringField(body, "message") ??
      stringField(body, "error_description") ??
      stringField(body, "error") ??
      `Provider returned HTTP ${response.status}.`,
  )
}

export async function validateCloudProviderToken(
  provider: CloudProviderId,
  value: string,
  request: CloudFetch = fetch,
  teamId?: string,
): Promise<{ account?: string; accountId?: string }> {
  const accessToken = value.trim()
  if (!accessToken) throw new Error(`Enter a ${providerLabel(provider)} personal access token.`)
  if (accessToken.length > 16_384) throw new Error(`${providerLabel(provider)} rejected the oversized token.`)
  return loadProviderIdentity(provider, accessToken, request, teamId).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.replaceAll(accessToken, "[redacted]"))
  })
}

async function loadProviderIdentity(
  provider: CloudProviderId,
  token: string,
  request: CloudFetch,
  teamId?: string,
): Promise<{ account?: string; accountId?: string }> {
  if (provider === "vercel") {
    const body = await providerJson(token, "https://api.vercel.com/v2/user", request)
    const user = body && typeof body === "object" && Reflect.get(body, "user") ? Reflect.get(body, "user") : body
    return {
      account: stringField(user, "username") ?? stringField(user, "name") ?? stringField(user, "email"),
      accountId: teamId ?? stringField(user, "id"),
    }
  }
  if (provider === "netlify") {
    const body = await providerJson(token, "https://api.netlify.com/api/v1/user", request)
    return {
      account: stringField(body, "full_name") ?? stringField(body, "email"),
      accountId: stringField(body, "id"),
    }
  }
  const body = await providerJson(token, "https://api.supabase.com/v1/organizations", request)
  const organization = Array.isArray(body) ? body[0] : undefined
  return {
    account: stringField(organization, "name") ?? stringField(organization, "slug") ?? "Supabase account",
    accountId: stringField(organization, "id") ?? stringField(organization, "slug"),
  }
}
