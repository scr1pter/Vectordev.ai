import { expect, test } from "bun:test"
import { Effect } from "effect"
import { createGitlabOAuth } from "../../src/oauth/gitlab"
import { gitlabDeviceMethod } from "../../src/plugin/provider/gitlab"
import {
  GITLAB_DEFAULT_CLIENT_ID,
  GITLAB_SIGN_IN,
  gitlabOAuthConfiguration,
  gitlabCredentialMatches,
  providerCredentialAllowed,
  requireGitlabOAuthEndpoint,
} from "../../src/provider-policy"

const registration = { origin: "https://gitlab.example.test", clientId: "a".repeat(64) }
const device = {
  device_code: "synthetic-device",
  user_code: "ABCD-1234",
  verification_uri: `${registration.origin}/oauth/device`,
  expires_in: 300,
  interval: 2,
}
const tokens = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_in: 7200,
  token_type: "Bearer",
  scope: "api",
}

function fixture(responses: Array<{ body: unknown; status?: number; headers?: HeadersInit }>, realDelay = false) {
  const requests: Array<{ path: string; body: Record<string, string>; agent: string | null }> = []
  const delays: number[] = []
  let now = 1000
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: Object.fromEntries(new URLSearchParams(await request.text())),
        agent: request.headers.get("user-agent"),
      })
      const response = responses.shift()
      if (!response) return Response.json({ error: "unexpected_request" }, { status: 500 })
      return Response.json(response.body, { status: response.status ?? 200, headers: response.headers })
    },
  })
  const oauth = createGitlabOAuth({
    fetch: Object.assign(
      (url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("error")
        expect(new URL(String(url)).origin).toBe(registration.origin)
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

test("Duo remains gated; own-client overrides and saved credentials bind to the exact origin", () => {
  expect(GITLAB_SIGN_IN).toBe(false)
  expect(gitlabOAuthConfiguration({ GITLAB_OAUTH_CLIENT_ID: registration.clientId })).toBeUndefined()
  expect(
    providerCredentialAllowed("gitlab", {
      type: "oauth",
      clientId: registration.clientId,
      enterpriseUrl: registration.origin,
    }),
  ).toBe(false)
  expect(providerCredentialAllowed("gitlab", { type: "api" })).toBe(true)
  expect(gitlabOAuthConfiguration({}, true)).toEqual({
    origin: "https://gitlab.com",
    clientId: GITLAB_DEFAULT_CLIENT_ID,
  })
  expect(gitlabOAuthConfiguration({ GITLAB_INSTANCE_URL: registration.origin }, true)).toBeUndefined()
  const configured = gitlabOAuthConfiguration(
    { GITLAB_INSTANCE_URL: registration.origin, GITLAB_OAUTH_CLIENT_ID: registration.clientId },
    true,
  )
  expect(configured).toEqual(registration)
  for (const origin of [
    "http://gitlab.example.test",
    "https://user@gitlab.example.test",
    "https://gitlab.example.test/path",
    "https://gitlab.example.test?x=1",
  ])
    expect(
      gitlabOAuthConfiguration({ GITLAB_INSTANCE_URL: origin, GITLAB_OAUTH_CLIENT_ID: registration.clientId }, true),
    ).toBeUndefined()
  expect(gitlabOAuthConfiguration({ GITLAB_OAUTH_CLIENT_ID: "not-a-registration" }, true)).toBeUndefined()
  const saved = { clientId: registration.clientId, enterpriseUrl: registration.origin }
  expect(gitlabCredentialMatches(saved, configured)).toBe(true)
  expect(gitlabCredentialMatches({ ...saved, clientId: "b".repeat(64) }, configured)).toBe(false)
  expect(gitlabCredentialMatches({ ...saved, enterpriseUrl: "https://gitlab.com" }, configured)).toBe(false)
  expect(
    gitlabCredentialMatches(
      { metadata: { oauth_client_id: registration.clientId, oauth_instance_url: registration.origin } },
      configured,
    ),
  ).toBe(true)
  for (const options of [
    { instanceUrl: "https://foreign.test" },
    { baseURL: "https://foreign.test/api" },
    { baseURL: `https://user@gitlab.example.test` },
  ])
    expect(() => requireGitlabOAuthEndpoint(saved, options, configured)).toThrow("different instance")
  expect(requireGitlabOAuthEndpoint(saved, { baseURL: `${registration.origin}/api/v4` }, configured)).toBe(
    registration.origin,
  )
})

test("actual device HTTP flow polls once, honors pending/slow_down and returns refreshable bound credentials", async () => {
  using app = fixture([
    { body: device },
    { body: { error: "authorization_pending" }, status: 400 },
    { body: { error: "slow_down" }, status: 400 },
    { body: tokens },
    { body: { ...tokens, access_token: "renewed" } },
  ])
  const flow = await app.oauth.authorize(registration, new AbortController().signal)
  expect(flow.url).toBe(device.verification_uri)
  expect(flow.instructions).toContain(device.user_code)
  expect(flow.instructions).not.toContain(device.device_code)
  const [value, same] = await Promise.all([flow.complete(), flow.complete()])
  expect(value).toEqual(same)
  expect(value).toMatchObject({
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  })
  expect(app.delays).toEqual([2000, 2000, 7000])
  expect(app.requests[0]).toMatchObject({
    path: "/oauth/authorize_device",
    body: { scope: "api", client_id: registration.clientId },
    agent: expect.stringContaining("vector/"),
  })
  expect(
    app.requests
      .slice(1)
      .every(
        (request) =>
          request.body.grant_type === "urn:ietf:params:oauth:grant-type:device_code" &&
          request.body.device_code === device.device_code,
      ),
  ).toBe(true)
  const renewed = await app.oauth.refresh(registration, value.refresh, new AbortController().signal)
  expect(renewed.access).toBe("renewed")
  expect(app.requests.at(-1)?.body).toEqual({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: registration.clientId,
  })
})

for (const [error, message] of [
  ["access_denied", "declined"],
  ["expired_token", "expired"],
  ["invalid_client", "failed"],
]) {
  test(`device ${error} stops polling with safe guidance`, async () => {
    using app = fixture([
      { body: device },
      { body: { error, error_description: "secret-that-must-not-be-printed" }, status: 400 },
    ])
    const flow = await app.oauth.authorize(registration, new AbortController().signal)
    await expect(flow.complete()).rejects.toThrow(message)
    expect(app.requests).toHaveLength(2)
  })
}

for (const changes of [
  { verification_uri: "https://foreign.test/oauth/device" },
  { verification_uri: `${registration.origin}/unsafe` },
  { interval: -1 },
  { expires_in: 0 },
  { user_code: "<script>" },
]) {
  test(`malformed device response is rejected: ${JSON.stringify(changes)}`, async () => {
    using app = fixture([{ body: { ...device, ...changes } }])
    await expect(app.oauth.authorize(registration, new AbortController().signal)).rejects.toThrow("invalid device")
    expect(app.requests).toHaveLength(1)
  })
}

test("expiry, cancellation and redirects stop without forwarding tokens", async () => {
  using expiring = fixture([{ body: { ...device, expires_in: 1 } }])
  const flow = await expiring.oauth.authorize(registration, new AbortController().signal)
  await expect(flow.complete()).rejects.toThrow("expired")
  expect(expiring.requests).toHaveLength(1)
  using cancelled = fixture([{ body: device }], true)
  const abort = new AbortController()
  const waiting = await cancelled.oauth.authorize(registration, abort.signal)
  const pending = waiting.complete()
  abort.abort(new Error("fixture cancelled"))
  await expect(pending).rejects.toThrow("fixture cancelled")
  expect(cancelled.requests).toHaveLength(1)
  using redirected = fixture([{ body: {}, status: 302, headers: { location: "https://foreign.test" } }])
  await expect(redirected.oauth.authorize(registration, new AbortController().signal)).rejects.toThrow("securely")
  expect(redirected.requests).toHaveLength(1)
})

test("malformed tokens and missing refresh grants fail without exposing credentials", async () => {
  using invalid = fixture([{ body: device }, { body: { ...tokens, expires_in: -1 } }])
  const flow = await invalid.oauth.authorize(registration, new AbortController().signal)
  await expect(flow.complete()).rejects.toThrow("invalid access token")
  using noRefresh = fixture([{ body: device }, { body: { ...tokens, refresh_token: undefined } }])
  const value = await (await noRefresh.oauth.authorize(registration, new AbortController().signal)).complete()
  expect(value.refresh).toBe("")
  await expect(noRefresh.oauth.refresh(registration, "", new AbortController().signal)).rejects.toThrow("Sign in again")
  expect(noRefresh.requests).toHaveLength(2)
})

test("native integration stores application/origin metadata and refreshes only matching credentials", async () => {
  using app = fixture([{ body: device }, { body: tokens }, { body: { ...tokens, access_token: "native-renewed" } }])
  const method = gitlabDeviceMethod(() => registration, app.oauth)
  const value = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* method.authorize({})
        if (result.mode !== "auto") throw new Error("Unexpected authorization mode")
        return yield* result.callback
      }),
    ),
  )
  expect(value).toMatchObject({
    type: "oauth",
    methodID: "gitlab-device",
    metadata: { oauth_client_id: registration.clientId, oauth_instance_url: registration.origin },
  })
  if (value.type !== "oauth") throw new Error("Expected OAuth credential")
  expect((await Effect.runPromise(method.refresh!(value))).access).toBe("native-renewed")
  await expect(
    Effect.runPromise(
      method.refresh!({ ...value, metadata: { ...value.metadata, oauth_instance_url: "https://foreign.test" } }),
    ),
  ).rejects.toThrow("another application or instance")
  expect(app.requests).toHaveLength(3)
})

test("disposing the native authorization scope cancels its pending device flow", async () => {
  using app = fixture([{ body: device }], true)
  const method = gitlabDeviceMethod(() => registration, app.oauth)
  const authorization = await Effect.runPromise(Effect.scoped(method.authorize({})))
  if (authorization.mode !== "auto") throw new Error("Expected device flow")
  await expect(Effect.runPromise(authorization.callback)).rejects.toThrow()
  expect(app.requests).toHaveLength(1)
})
