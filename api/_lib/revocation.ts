/**
 * CLI tokens are stateless HMAC grants with a ninety-day life (see cli-token.ts),
 * so deleting an account does not, by itself, stop a terminal that already holds
 * one. This is the small revocation list that closes that window: the account id
 * is written to the same Redis the rate limiter uses, and CLI verification
 * refuses any token whose subject appears there.
 *
 * The entry outlives the longest token it could invalidate, then expires on its
 * own, so the list never grows without bound.
 */

const REVOCATION_TTL_SECONDS = 100 * 24 * 60 * 60

function store() {
  const url = process.env.KV_REST_API_URL?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.KV_REST_API_TOKEN?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  return url && token ? { url: url.replace(/\/+$/, ""), token } : undefined
}

export function revocationConfigured() {
  return Boolean(store())
}

const key = (accountID: string) => `vector:cli-revoked:${accountID}`

/**
 * Returns false when no store is configured: the caller reports that tokens stay
 * valid until they expire rather than pretending the account was fully closed.
 */
export async function revokeAccountTokens(accountID: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const kv = store()
  if (!kv) return false
  const response = await fetcher(`${kv.url}/set/${encodeURIComponent(key(accountID))}/1?ex=${REVOCATION_TTL_SECONDS}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
  }).catch(() => undefined)
  return Boolean(response?.ok)
}

/**
 * Fails open. A Redis outage must not lock every signed-in terminal out of a
 * free CLI; the account itself is already gone from Supabase, which is what
 * stops new tokens being minted.
 */
export async function accountTokensRevoked(accountID: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const kv = store()
  if (!kv) return false
  const response = await fetcher(`${kv.url}/get/${encodeURIComponent(key(accountID))}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  }).catch(() => undefined)
  if (!response?.ok) return false
  const body: unknown = await response.json().catch(() => undefined)
  return Boolean(body && typeof body === "object" && "result" in body && body.result)
}
