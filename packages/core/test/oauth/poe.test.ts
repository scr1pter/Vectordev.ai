import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { createPoeOAuth } from "../../src/oauth/poe"
import { poeOAuthConfiguration, POE_CLIENT_ID, POE_SIGN_IN, providerCredentialAllowed } from "../../src/provider-policy"
import { poeOAuthMethod } from "../../src/plugin/provider/poe"

const registration = poeOAuthConfiguration({ VECTOR_POE_OAUTH_CLIENT_ID: "vector-test-client" }, true)!
function fixture(response: unknown) {
  const requests: Record<string, string>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(Object.fromEntries(new URLSearchParams(await request.text())))
      return Response.json(response)
    },
  })
  const oauth = createPoeOAuth({
    now: () => 1000,
    fetch: Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.poe.com/token")
        expect(init?.redirect).toBe("error")
        return fetch(server.url, init)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  return {
    oauth,
    requests,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}
async function callback(url: string, state?: string) {
  const authorize = new URL(url)
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!)
  redirect.search = new URLSearchParams({
    state: state ?? authorize.searchParams.get("state")!,
    code: "synthetic-code",
  }).toString()
  return fetch(redirect)
}
test("Poe requires a Vector-owned client and explicit release enablement", () => {
  expect(POE_SIGN_IN).toBe(false)
  expect(POE_CLIENT_ID).toBe("")
  expect(poeOAuthConfiguration({ VECTOR_POE_OAUTH_CLIENT_ID: registration.clientId })).toBeUndefined()
  expect(poeOAuthConfiguration({}, true)).toBeUndefined()
  expect(providerCredentialAllowed("poe", { type: "api" })).toBe(true)
  expect(
    providerCredentialAllowed("poe", {
      type: "oauth",
      clientId: registration.clientId,
      enterpriseUrl: registration.origin,
    }),
  ).toBe(false)
})
test("Poe exchanges its scoped PKCE code for an expiring key exactly once", async () => {
  using f = fixture({ api_key: "synthetic-key", api_key_expires_in: 3600 })
  const flow = await f.oauth.authorize(registration, new AbortController().signal)
  const url = new URL(flow.url)
  expect(url.origin + url.pathname).toBe("https://poe.com/oauth/authorize")
  expect(url.searchParams.get("scope")).toBe("apikey:create")
  expect(url.searchParams.get("client_id")).toBe(registration.clientId)
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect((await callback(flow.url, "bad-state")).status).toBe(400)
  expect(f.requests).toHaveLength(0)
  expect((await callback(flow.url)).status).toBe(200)
  const value = await flow.complete()
  expect(value).toEqual({
    access: "synthetic-key",
    refresh: "",
    expires: 3_601_000,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  })
  expect(await flow.complete()).toEqual(value)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({
    client_id: registration.clientId,
    grant_type: "authorization_code",
    code: "synthetic-code",
    redirect_uri: url.searchParams.get("redirect_uri")!,
  })
  expect(createHash("sha256").update(f.requests[0].code_verifier).digest("base64url")).toBe(
    url.searchParams.get("code_challenge")!,
  )
})
test("Poe preserves explicit nonexpiring grants and refuses missing/malformed expiry", async () => {
  for (const expiry of [null, undefined, 0, -1, "3600", 1.5]) {
    using f = fixture({ api_key: "synthetic-key", api_key_expires_in: expiry })
    const flow = await f.oauth.authorize(registration, new AbortController().signal)
    await callback(flow.url)
    if (expiry === null) expect((await flow.complete()).expires).toBe(Number.MAX_SAFE_INTEGER)
    if (expiry !== null) await expect(flow.complete()).rejects.toThrow("invalid API-key expiry")
  }
})
test("native Poe credentials preserve delegated key expiry and cancellation never exchanges a code", async () => {
  using f = fixture({ api_key: "synthetic-key", api_key_expires_in: 60 })
  const method = poeOAuthMethod(() => registration, f.oauth)
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const flow = yield* method.authorize({})
        if (flow.mode !== "auto") throw new Error("expected automatic flow")
        yield* Effect.promise(() => callback(flow.url))
        return yield* flow.callback
      }),
    ),
  )
  expect(value).toMatchObject({
    type: "oauth",
    access: "synthetic-key",
    refresh: "",
    expires: 61_000,
    metadata: { oauth_client_id: registration.clientId, oauth_instance_url: registration.origin },
  })
  const abort = new AbortController()
  const pending = await f.oauth.authorize(registration, abort.signal)
  abort.abort()
  await expect(pending.complete()).rejects.toThrow("cancelled")
  expect(f.requests).toHaveLength(1)
})
