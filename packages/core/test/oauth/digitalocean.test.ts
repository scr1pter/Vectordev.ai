import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createDigitalOceanOAuth } from "../../src/oauth/digitalocean"
import {
  digitalOceanOAuthConfiguration,
  DIGITALOCEAN_CLIENT_ID,
  DIGITALOCEAN_SIGN_IN,
  providerCredentialAllowed,
} from "../../src/provider-policy"
import { digitalOceanOAuthMethod } from "../../src/plugin/provider/digitalocean"

const registration = {
  ...digitalOceanOAuthConfiguration({ VECTOR_DIGITALOCEAN_OAUTH_CLIENT_ID: "vector-test-client" }, true)!,
  redirectUri: "http://localhost:0/auth/callback",
}
async function callback(url: string, body?: Record<string, unknown>, headers?: HeadersInit) {
  const authorize = new URL(url)
  const redirect = new URL(authorize.searchParams.get("redirect_uri")!)
  return fetch(new URL("/auth/token", redirect), {
    method: "POST",
    headers: { "content-type": "application/json", origin: redirect.origin, ...headers },
    body: JSON.stringify({
      access_token: "synthetic-token",
      token_type: "bearer",
      expires_in: "3600",
      state: authorize.searchParams.get("state"),
      ...body,
    }),
  })
}
test("DigitalOcean application override does not bypass gate; borrowed-key metadata remains refused", () => {
  expect(DIGITALOCEAN_SIGN_IN).toBe(false)
  expect(DIGITALOCEAN_CLIENT_ID).toBe("")
  expect(digitalOceanOAuthConfiguration({ VECTOR_DIGITALOCEAN_OAUTH_CLIENT_ID: registration.clientId })).toBeUndefined()
  expect(digitalOceanOAuthConfiguration({}, true)).toBeUndefined()
  expect(registration.scope).toBe("genai:read inference:query")
  expect(providerCredentialAllowed("digitalocean", { type: "api" })).toBe(true)
  expect(providerCredentialAllowed("digitalocean", { type: "api", metadata: { oauth_access: "old" } })).toBe(false)
})
test("implicit localhost flow validates Origin/Host/state and preserves actual expiry", async () => {
  const oauth = createDigitalOceanOAuth({ now: () => 1000 })
  const flow = await oauth.authorize(registration, new AbortController().signal)
  const authorize = new URL(flow.url)
  expect(authorize.searchParams.get("response_type")).toBe("token")
  expect(authorize.searchParams.get("scope")).toBe(registration.scope)
  const page = await fetch(authorize.searchParams.get("redirect_uri")!)
  expect(page.headers.get("referrer-policy")).toBe("no-referrer")
  expect(await page.text()).toContain('window.history.replaceState(null,"",window.location.pathname)')
  expect((await callback(flow.url, { state: "wrong" })).status).toBe(400)
  expect((await callback(flow.url, {}, { origin: "https://attacker.test" })).status).toBe(403)
  expect((await callback(flow.url, {}, { host: "attacker.test" })).status).toBe(400)
  for (const expires_in of [undefined, "bad", "0", "-1", 0])
    expect((await callback(flow.url, { expires_in })).status).toBe(400)
  expect((await callback(flow.url)).status).toBe(200)
  expect(await flow.complete()).toEqual({
    access: "synthetic-token",
    refresh: "",
    expires: 3_601_000,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  })
  await expect(callback(flow.url)).rejects.toThrow()
})
test("implicit denial needs correct state; cancellation and timeout close listeners", async () => {
  const oauth = createDigitalOceanOAuth()
  const abort = new AbortController()
  const flow = await oauth.authorize(registration, abort.signal)
  expect((await callback(flow.url, { state: "wrong", error: "access_denied" })).status).toBe(400)
  expect((await callback(flow.url, { error: "access_denied", error_description: "secret" })).status).toBe(400)
  await expect(flow.complete()).rejects.toThrow("authorization was declined")
  const cancel = await oauth.authorize(registration, abort.signal)
  abort.abort()
  await expect(cancel.complete()).rejects.toThrow("cancelled")
  const timed = await createDigitalOceanOAuth({ timeoutMs: 10 }).authorize(registration, new AbortController().signal)
  await expect(timed.complete()).rejects.toThrow("timed out")
})
test("native DigitalOcean method saves OAuth expiry and application identity, not an unbounded API key", async () => {
  const method = digitalOceanOAuthMethod(() => registration, createDigitalOceanOAuth({ now: () => 2000 }))
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
    expires: 3_602_000,
    refresh: "",
    metadata: { oauth_client_id: registration.clientId, oauth_instance_url: registration.origin },
  })
})
test("router discovery uses only DigitalOcean API with bounded schema and no redirects", async () => {
  const requests: Headers[] = []
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new Headers(request.headers))
      return Response.json({ model_routers: [{ name: "my-router" }, { name: "../invalid" }, { name: "" }, null] })
    },
  })
  const oauth = createDigitalOceanOAuth({
    fetch: Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.digitalocean.com/v2/gen-ai/models/routers")
        expect(init?.redirect).toBe("error")
        return fetch(server.url, init)
      },
      { preconnect: fetch.preconnect },
    ),
  })
  expect(await oauth.routers("synthetic-token", new AbortController().signal)).toEqual([{ name: "my-router" }])
  expect(requests[0].get("authorization")).toBe("Bearer synthetic-token")
})
