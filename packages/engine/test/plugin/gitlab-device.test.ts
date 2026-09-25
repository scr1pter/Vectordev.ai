import { expect, test } from "bun:test"
import type { PluginInput } from "@vectordevai/plugin"
import { createGitlabOAuth } from "@vectordevai/core/oauth/gitlab"
import { Auth } from "../../src/auth"
import { gitlabAuthHooks, GitlabAuthPlugin } from "../../src/plugin/gitlab"

const registration = { origin: "https://gitlab.fixture.test", clientId: "a".repeat(64) }
function fixture(realDelay = false) {
  const requests: { path: string; body: Record<string, string> }[] = []
  const saved: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: Object.fromEntries(new URLSearchParams(await request.text())),
      })
      if (new URL(request.url).pathname === "/oauth/authorize_device")
        return Response.json({
          device_code: "synthetic-device",
          user_code: "1234-ABCD",
          verification_uri: `${registration.origin}/oauth/device`,
          expires_in: 300,
          interval: 1,
        })
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
        scope: "api",
        token_type: "Bearer",
      })
    },
  })
  const input = {
    client: {
      auth: {
        set: async (value: unknown) => {
          saved.push(value)
        },
      },
    },
  } as unknown as PluginInput
  const oauth = createGitlabOAuth({
    fetch: Object.assign(
      (url: RequestInfo | URL, init?: RequestInit) => fetch(new URL(new URL(String(url)).pathname, server.url), init),
      { preconnect: fetch.preconnect },
    ),
    ...(realDelay ? {} : { sleep: async () => {} }),
  })
  const hooks = gitlabAuthHooks(input, () => registration, oauth)
  const method = hooks.auth!.methods.find((method) => method.type === "oauth")!
  if (method.type !== "oauth") throw new Error("Expected device method")
  return {
    hooks,
    method,
    requests,
    saved,
    [Symbol.asyncDispose]: async () => {
      await hooks.dispose!()
      server.stop(true)
    },
  }
}

test("the shipped Duo plugin remains gated even with an explicitly configured application", async () => {
  const hooks = await GitlabAuthPlugin({} as PluginInput)
  expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
  await hooks.dispose!()
})

test("legacy device callback preserves client/origin in the real auth schema and refresh persists it", async () => {
  await using app = fixture()
  const flow = await app.method.authorize({ instanceUrl: registration.origin })
  expect(flow.method).toBe("auto")
  if (flow.method !== "auto") throw new Error("Expected auto flow")
  const result = await flow.callback()
  if (result.type !== "success" || !("refresh" in result)) throw new Error("Expected OAuth success")
  const credential = Auth.Oauth.make({ ...result, type: "oauth" })
  expect(credential).toMatchObject({
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
    refresh: "synthetic-refresh",
  })
  const loaded = await app.hooks.auth!.loader!(async () => ({ ...credential, expires: 0 }), {} as never)
  expect(loaded).toEqual({
    apiKey: "synthetic-access",
    instanceUrl: registration.origin,
    clientId: registration.clientId,
  })
  expect(app.saved).toEqual([
    {
      path: { id: "gitlab" },
      body: expect.objectContaining({
        type: "oauth",
        clientId: registration.clientId,
        enterpriseUrl: registration.origin,
      }),
    },
  ])
  expect(app.requests.map((request) => request.path)).toEqual([
    "/oauth/authorize_device",
    "/oauth/token",
    "/oauth/token",
  ])
  expect(app.requests[0].body.scope).toBe("api")
  expect(app.requests[1].body.grant_type).toBe("urn:ietf:params:oauth:grant-type:device_code")
  expect(app.requests[2].body.grant_type).toBe("refresh_token")
})

test("a different app, instance or missing registration never reuses a stored OAuth token", async () => {
  await using app = fixture()
  const credential = {
    type: "oauth" as const,
    access: "stored-access",
    refresh: "stored-refresh",
    expires: 0,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  }
  for (const value of [
    { ...credential, clientId: "b".repeat(64) },
    { ...credential, enterpriseUrl: "https://other.test" },
    { ...credential, clientId: undefined },
  ])
    expect(await app.hooks.auth!.loader!(async () => value, {} as never)).toEqual({})
  await expect(app.method.authorize({ instanceUrl: "https://other.test" })).rejects.toThrow(
    "your own GITLAB_OAUTH_CLIENT_ID",
  )
  expect(app.requests).toEqual([])
  expect(app.saved).toEqual([])
})

test("restarting or disposing device sign-in cancels pending polling", async () => {
  await using app = fixture(true)
  const first = await app.method.authorize()
  if (first.method !== "auto") throw new Error("Expected auto flow")
  const pending = first.callback()
  const rejected = pending.then(
    () => undefined,
    (error: unknown) => error,
  )
  const second = await app.method.authorize()
  expect(await rejected).toBeInstanceOf(Error)
  if (second.method !== "auto") throw new Error("Expected auto flow")
  const other = second.callback()
  const stopped = other.then(
    () => undefined,
    (error: unknown) => error,
  )
  await app.hooks.dispose!()
  expect(await stopped).toBeInstanceOf(Error)
  expect(app.requests.map((request) => request.path)).toEqual(["/oauth/authorize_device", "/oauth/authorize_device"])
  expect(app.saved).toEqual([])
})
