import { expect, test } from "bun:test"
import type { PluginInput } from "@vectordevai/plugin"
import { xaiOAuthConfiguration } from "@vectordevai/core/provider-policy"
import { createXaiOAuth } from "@vectordevai/core/oauth/xai"
import { Auth } from "../../src/auth"
import { XaiAuthPlugin, xaiAuthHooks } from "../../src/plugin/xai"

const registration = {
  ...xaiOAuthConfiguration({ VECTOR_XAI_OAUTH_CLIENT_ID: "vector-test-client" }, true)!,
  redirectUri: "http://127.0.0.1:0/oauth/xai/callback",
}
function fixture() {
  const requests: string[] = []
  const saved: unknown[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return Response.json(
        request.url.includes("device/code")
          ? {
              device_code: "fixture-device",
              verification_uri: "https://auth.x.ai/device",
              user_code: "ABCD-1234",
              interval: 1,
              expires_in: 60,
            }
          : {
              access_token: "fixture-access",
              refresh_token: "fixture-refresh",
              expires_in: 3600,
              token_type: "bearer",
            },
      )
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
  const oauth = createXaiOAuth({
    fetch: Object.assign(
      (url: RequestInfo | URL, init?: RequestInit) => fetch(new URL(new URL(String(url)).pathname, server.url), init),
      { preconnect: fetch.preconnect },
    ),
    sleep: async () => {},
  })
  const hooks = xaiAuthHooks(input, () => registration, oauth)
  return {
    hooks,
    requests,
    saved,
    async [Symbol.asyncDispose]() {
      await hooks.dispose!()
      server.stop(true)
    },
  }
}
test("xAI shipped methods are API-key-only and ignore unregistered saved OAuth", async () => {
  const hooks = await XaiAuthPlugin({} as PluginInput)
  expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
  expect(
    await hooks.auth!.loader!(async () => ({ type: "oauth", access: "old", refresh: "old", expires: 0 }), {} as never),
  ).toEqual({})
  await hooks.dispose!()
})
test("legacy owned browser and device flows preserve exact registration in the real auth schema", async () => {
  await using f = fixture()
  for (const method of f.hooks.auth!.methods.filter((item) => item.type === "oauth")) {
    if (method.type !== "oauth") throw new Error("Expected OAuth")
    const flow = await method.authorize()
    if (flow.method !== "auto") throw new Error("Expected automatic completion")
    const url = new URL(flow.url)
    if (url.searchParams.has("redirect_uri")) {
      const callback = new URL(url.searchParams.get("redirect_uri")!)
      callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "fixture-code" }).toString()
      expect((await fetch(callback)).status).toBe(200)
      expect(url.searchParams.get("referrer")).toBe("vector")
    }
    const result = await flow.callback()
    if (result.type !== "success" || !("refresh" in result)) throw new Error("Expected OAuth credential")
    expect(Auth.Oauth.make({ ...result, type: "oauth" })).toMatchObject({
      access: "fixture-access",
      clientId: registration.clientId,
      enterpriseUrl: registration.origin,
    })
  }
  expect(f.requests).toEqual(["/oauth2/token", "/oauth2/device/code", "/oauth2/token"])
})
test("legacy loader rejects unrelated saved clients and configuration gateways before accessing credentials", async () => {
  await using f = fixture()
  const auth = {
    type: "oauth" as const,
    access: "stored",
    refresh: "refresh",
    expires: 0,
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
  }
  expect(await f.hooks.auth!.loader!(async () => ({ ...auth, clientId: "foreign-client" }), {} as never)).toEqual({})
  const loaded = await f.hooks.auth!.loader!(async () => auth, {} as never)
  await expect(loaded.fetch("https://gateway.example/v1/responses")).rejects.toThrow("different provider origin")
  expect(f.requests).toEqual([])
  expect(f.saved).toEqual([])
})
test("disposal closes an unfinished browser sign-in without token exchange", async () => {
  await using f = fixture()
  const method = f.hooks.auth!.methods[0]
  if (method.type !== "oauth") throw new Error("Expected OAuth")
  const flow = await method.authorize()
  if (flow.method !== "auto") throw new Error("Expected automatic completion")
  const completion = flow.callback().catch((error: unknown) => error)
  await f.hooks.dispose!()
  expect(await completion).toBeInstanceOf(Error)
  expect(f.requests).toEqual([])
})
