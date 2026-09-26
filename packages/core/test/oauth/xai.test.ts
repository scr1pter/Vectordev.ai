import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { xaiOAuthConfiguration, XAI_CLIENT_ID, XAI_SIGN_IN, providerCredentialAllowed } from "../../src/provider-policy"
import { createXaiOAuth } from "../../src/oauth/xai"
import { ownedOAuthFetch } from "../../src/oauth/owned"
import { xaiOAuthMethod } from "../../src/plugin/provider/xai"

const registration = {
  ...xaiOAuthConfiguration({ VECTOR_XAI_OAUTH_CLIENT_ID: "vector-test-client" }, true)!,
  redirectUri: "http://127.0.0.1:0/oauth/xai/callback",
}
const tokens = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_in: 3600,
  token_type: "bearer",
}
function fixture(options?: { timeoutMs?: number; realDelay?: boolean }) {
  const requests: { path: string; body: Record<string, string> }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: Object.fromEntries(new URLSearchParams(await request.text())),
      })
      return Response.json(
        request.url.includes("/device/code")
          ? {
              device_code: "synthetic-device",
              user_code: "ABCD-1234",
              expires_in: 600,
              interval: 1,
              verification_uri: "https://auth.x.ai/device",
            }
          : tokens,
      )
    },
  })
  const oauth = createXaiOAuth({
    fetch: Object.assign(
      (url: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(url)).origin).toBe("https://auth.x.ai")
        expect(init?.redirect).toBe("error")
        return fetch(new URL(new URL(String(url)).pathname, server.url), init)
      },
      { preconnect: fetch.preconnect },
    ),
    ...(options?.realDelay ? {} : { sleep: async () => {} }),
    timeoutMs: options?.timeoutMs,
  })
  return {
    oauth,
    requests,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}
async function finish(url: string, extra?: Record<string, string>) {
  const authorization = new URL(url)
  const callback = new URL(authorization.searchParams.get("redirect_uri")!)
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state")!,
    code: "synthetic-code",
    ...extra,
  }).toString()
  return fetch(callback)
}
test("xAI requires its own registration and release approval; API keys remain available", () => {
  expect(XAI_SIGN_IN).toBe(false)
  expect(XAI_CLIENT_ID).toBe("")
  expect(xaiOAuthConfiguration({ VECTOR_XAI_OAUTH_CLIENT_ID: registration.clientId })).toBeUndefined()
  expect(xaiOAuthConfiguration({}, true)).toBeUndefined()
  expect(providerCredentialAllowed("xai", { type: "api" })).toBe(true)
  expect(
    providerCredentialAllowed("xai", {
      type: "oauth",
      clientId: registration.clientId,
      enterpriseUrl: registration.origin,
    }),
  ).toBe(false)
  expect(registration.scope.split(" ")).toEqual(["openid", "profile", "email", "offline_access", "api:access"])
  for (const uri of [
    "https://example.test/callback",
    "http://0.0.0.0:1457/callback",
    "http://127.0.0.1:1457/callback?secret=bad",
    "http://user@127.0.0.1:1457/callback",
  ])
    expect(
      xaiOAuthConfiguration(
        { VECTOR_XAI_OAUTH_CLIENT_ID: registration.clientId, VECTOR_XAI_OAUTH_REDIRECT_URI: uri },
        true,
      ),
    ).toBeUndefined()
})
test("browser callback binds PKCE/state and Vector registration without leaking verifier into authorization URL", async () => {
  using f = fixture()
  const flow = await f.oauth.browser(registration, new AbortController().signal)
  const url = new URL(flow.url)
  expect(url.origin).toBe(registration.origin)
  expect(url.searchParams.get("referrer")).toBe("vector")
  expect(url.searchParams.get("client_id")).toBe(registration.clientId)
  expect(url.searchParams.get("code_verifier")).toBeNull()
  expect((await finish(flow.url, { state: "incorrect" })).status).toBe(400)
  expect(f.requests).toHaveLength(0)
  expect((await finish(flow.url)).status).toBe(200)
  const value = await flow.complete()
  expect(value).toMatchObject({
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
    access: tokens.access_token,
  })
  expect(f.requests[0].body.redirect_uri).toBe(url.searchParams.get("redirect_uri")!)
  expect(createHash("sha256").update(f.requests[0].body.code_verifier).digest("base64url")).toBe(
    url.searchParams.get("code_challenge")!,
  )
  expect(f.requests[0].body.client_id).toBe(registration.clientId)
  await expect(finish(flow.url)).rejects.toThrow()
})
test("loopback rejects wrong host, callback errors, duplicate parameters and reuse; pending flows time out or cancel", async () => {
  using f = fixture()
  const abort = new AbortController()
  const flow = await f.oauth.browser(registration, abort.signal)
  const url = new URL(flow.url)
  const callback = new URL(url.searchParams.get("redirect_uri")!)
  callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "one" }).toString()
  callback.searchParams.append("code", "two")
  expect((await fetch(callback)).status).toBe(400)
  expect((await fetch(callback, { headers: { host: "attacker.example" } })).status).toBe(400)
  expect(f.requests).toHaveLength(0)
  abort.abort()
  await expect(flow.complete()).rejects.toThrow("cancelled")
  using timed = fixture({ timeoutMs: 10 })
  await expect((await timed.oauth.browser(registration, new AbortController().signal)).complete()).rejects.toThrow(
    "timed out",
  )
  const declined = await f.oauth.browser(registration, new AbortController().signal)
  await finish(declined.url, { error: "access_denied", error_description: "secret-from-provider" })
  await expect(declined.complete()).rejects.toThrow("Provider sign-in was declined")
  expect(f.requests).toHaveLength(0)
})
test("native device sign-in and refresh preserve provider/client identity", async () => {
  using f = fixture()
  const method = xaiOAuthMethod("device", () => registration, f.oauth)
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const flow = yield* method.authorize({})
        if (flow.mode !== "auto") throw new Error("expected automatic flow")
        return yield* flow.callback
      }),
    ),
  )
  expect(value).toMatchObject({
    type: "oauth",
    metadata: { oauth_client_id: registration.clientId, oauth_instance_url: registration.origin },
  })
  expect(f.requests[0].body.scope).toBe(registration.scope)
  if (value.type !== "oauth") throw new Error("expected oauth")
  const refreshed = await Effect.runPromise(method.refresh!(value))
  expect(refreshed.access).toBe(tokens.access_token)
  expect(f.requests.at(-1)?.body.grant_type).toBe("refresh_token")
  await expect(
    Effect.runPromise(method.refresh!({ ...value, metadata: { oauth_client_id: "another-client" } })),
  ).rejects.toThrow("registration changed")
})
test("an OAuth token cannot follow configured gateways or redirects", async () => {
  let calls = 0
  const sent: Request[] = []
  const send = ownedOAuthFetch(
    "https://api.x.ai",
    async () => {
      calls++
      return "synthetic-token"
    },
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Request(input, init))
        return new Response("ok")
      },
      { preconnect: fetch.preconnect },
    ),
  )
  await expect(send("https://gateway.example/v1/responses")).rejects.toThrow("different provider origin")
  expect(calls).toBe(0)
  await send("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { Authorization: "wrong", "x-api-key": "wrong" },
    body: "{}",
  })
  expect(sent[0].headers.get("authorization")).toBe("Bearer synthetic-token")
  expect(sent[0].headers.get("x-api-key")).toBeNull()
  expect(sent[0].redirect).toBe("error")
})
