import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createDeviceOAuth } from "../../src/oauth/device"
import { copilotFetch, copilotHeaders } from "../../src/oauth/copilot"
import {
  copilotOAuthConfiguration,
  COPILOT_CLIENT_ID,
  COPILOT_SIGN_IN,
  ownedOAuthMatches,
  providerCredentialAllowed,
} from "../../src/provider-policy"
import { copilotDeviceMethod } from "../../src/plugin/provider/github-copilot"

const registration = copilotOAuthConfiguration({ VECTOR_COPILOT_OAUTH_CLIENT_ID: "synthetic-vector-client" }, true)!
const device = {
  verification_uri: "https://github.com/login/device",
  device_code: "synthetic-device",
  user_code: "ABCD-1234",
  interval: 2,
  expires_in: 900,
}
const token = {
  access_token: "synthetic-access",
  token_type: "bearer",
  refresh_token: "synthetic-refresh",
  expires_in: 3600,
}
function fixture(responses: unknown[], realDelay = false) {
  const requests: Array<{ path: string; body: Record<string, string>; headers: Headers }> = []
  const delays: number[] = []
  let now = 1000
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: Object.fromEntries(new URLSearchParams(await request.text())),
        headers: request.headers,
      })
      return Response.json(responses.shift() ?? { error: "unexpected" })
    },
  })
  const oauth = createDeviceOAuth({
    fetch: Object.assign(
      (url: RequestInfo | URL, init?: RequestInit) => {
        expect(new URL(String(url)).origin).toBe(registration.origin)
        expect(init?.redirect).toBe("error")
        return fetch(new URL(new URL(String(url)).pathname, server.url), init)
      },
      { preconnect: fetch.preconnect },
    ),
    now: () => now,
    ...(realDelay
      ? {}
      : {
          sleep: async (duration: number, signal: AbortSignal) => {
            signal.throwIfAborted()
            delays.push(duration)
            now += duration
          },
        }),
  })
  return {
    oauth,
    requests,
    delays,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}
test("Copilot has no client or enabled sign-in; an environment override cannot enable it", () => {
  expect(COPILOT_SIGN_IN).toBe(false)
  expect(COPILOT_CLIENT_ID).toBe("")
  expect(copilotOAuthConfiguration({ VECTOR_COPILOT_OAUTH_CLIENT_ID: registration.clientId })).toBeUndefined()
  expect(copilotOAuthConfiguration({}, true)).toBeUndefined()
  expect(
    providerCredentialAllowed(
      "github-copilot",
      { type: "oauth", clientId: registration.clientId, enterpriseUrl: registration.origin },
      true,
    ),
  ).toBe(false)
})
test("approved registration device flow polls pending and cumulative slowdown, preserving exact client ownership", async () => {
  using f = fixture([device, { error: "authorization_pending" }, { error: "slow_down" }, { error: "slow_down" }, token])
  const flow = await f.oauth.authorize(registration, new AbortController().signal, true)
  const value = await flow.complete()
  expect(await flow.complete()).toEqual(value)
  expect(f.requests).toHaveLength(5)
  expect(f.delays).toEqual([2000, 2000, 7000, 12000])
  expect(f.requests[0].body).toEqual({ client_id: registration.clientId, scope: "read:user" })
  expect(f.requests[1].body).toEqual({
    client_id: registration.clientId,
    device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  })
  expect(value).toMatchObject({
    access: token.access_token,
    refresh: token.refresh_token,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  })
  expect(ownedOAuthMatches(value, registration)).toBe(true)
  expect(ownedOAuthMatches(value, { ...registration, clientId: "another-client" })).toBe(false)
})
test("device errors, invalid verification hosts, cancellation and expiry never produce credentials", async () => {
  for (const error of ["access_denied", "expired_token", "unexpected"]) {
    using f = fixture([device, { error, error_description: "secret-must-not-leak" }])
    await expect((await f.oauth.authorize(registration, new AbortController().signal)).complete()).rejects.not.toThrow(
      "secret-must-not-leak",
    )
  }
  using invalid = fixture([{ ...device, verification_uri: "https://attacker.example/login/device" }])
  await expect(invalid.oauth.authorize(registration, new AbortController().signal)).rejects.toThrow("invalid device")
  using expired = fixture([{ ...device, expires_in: 1 }])
  await expect((await expired.oauth.authorize(registration, new AbortController().signal)).complete()).rejects.toThrow(
    "expired",
  )
  expect(expired.requests).toHaveLength(1)
  using cancelled = fixture([device], true)
  const abort = new AbortController()
  const pending = (await cancelled.oauth.authorize(registration, abort.signal)).complete()
  abort.abort(new Error("synthetic cancelled"))
  await expect(pending).rejects.toThrow("synthetic cancelled")
  expect(cancelled.requests).toHaveLength(1)
})
test("non-expiring and refreshable GitHub tokens are represented truthfully", async () => {
  using f = fixture([device, { access_token: "synthetic-static", token_type: "bearer" }, token])
  const value = await (await f.oauth.authorize(registration, new AbortController().signal, true)).complete()
  expect(value.refresh).toBe("")
  expect(value.expires).toBe(Number.MAX_SAFE_INTEGER)
  const renewed = await f.oauth.refresh(registration, "synthetic-refresh", new AbortController().signal)
  expect(renewed.refresh).toBe(token.refresh_token)
  expect(f.requests.at(-1)?.body.grant_type).toBe("refresh_token")
})
test("native sign-in stores the approved app identity and aborts disposed attempts", async () => {
  using f = fixture([device, token])
  const method = copilotDeviceMethod(() => registration, f.oauth)
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const attempt = yield* method.authorize({})
        if (attempt.mode !== "auto") throw new Error("expected auto")
        return yield* attempt.callback
      }),
    ),
  )
  expect(value).toMatchObject({
    type: "oauth",
    access: token.access_token,
    metadata: { oauth_client_id: registration.clientId, oauth_instance_url: registration.origin },
  })
})
test("Copilot requests bind bearer tokens to the API host and cannot force a billing category", async () => {
  const requests: Request[] = []
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init))
      return new Response("ok")
    },
    { preconnect: fetch.preconnect },
  )
  const send = copilotFetch(async () => "synthetic-token", transport)
  await send("https://api.githubcopilot.com/chat/completions", {
    method: "POST",
    headers: { "x-initiator": "agent", "X-API-Key": "unused", authorization: "wrong" },
    body: JSON.stringify({ messages: [{ role: "user", content: "manual request" }] }),
  })
  expect(requests[0].headers.get("x-initiator")).toBe("user")
  expect(requests[0].headers.get("authorization")).toBe("Bearer synthetic-token")
  expect(requests[0].headers.get("x-api-key")).toBeNull()
  expect(requests[0].redirect).toBe("error")
  expect(
    copilotHeaders(JSON.stringify({ messages: [{ role: "user", content: [{ type: "tool_result" }] }] }))["x-initiator"],
  ).toBe("agent")
  expect(
    copilotHeaders(JSON.stringify({ input: [{ role: "user", content: [{ type: "input_image" }] }] }))[
      "Copilot-Vision-Request"
    ],
  ).toBe("true")
  await expect(send("https://attacker.example/chat", {})).rejects.toThrow("another API origin")
  expect(requests).toHaveLength(1)
})
