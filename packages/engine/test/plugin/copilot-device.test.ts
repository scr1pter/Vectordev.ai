import { expect, test } from "bun:test"
import type { PluginInput } from "@vectordevai/plugin"
import { copilotOAuthConfiguration } from "@vectordevai/core/provider-policy"
import { createDeviceOAuth } from "@vectordevai/core/oauth/device"
import { Auth } from "../../src/auth"
import { copilotAuthHooks, CopilotAuthPlugin } from "../../src/plugin/github-copilot/copilot"

const registration = copilotOAuthConfiguration({ VECTOR_COPILOT_OAUTH_CLIENT_ID: "vector-test-client" }, true)!
test("the shipped Copilot adapter remains inert", async () => {
  expect((await CopilotAuthPlugin({} as PluginInput)).auth?.methods).toEqual([])
})
test("legacy device completion persists client identity and disposing cancels polling", async () => {
  const requests: string[] = []
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(new URL(request.url).pathname)
      return Response.json(
        request.url.includes("/device/")
          ? {
              verification_uri: "https://github.com/login/device",
              user_code: "ABCD-1234",
              device_code: "synthetic-code",
              expires_in: 60,
              interval: 1,
            }
          : { access_token: "synthetic-token", token_type: "bearer" },
      )
    },
  })
  const transport = Object.assign(
    (url: RequestInfo | URL, init?: RequestInit) => fetch(new URL(new URL(String(url)).pathname, server.url), init),
    { preconnect: fetch.preconnect },
  )
  const hooks = copilotAuthHooks(
    {} as PluginInput,
    () => registration,
    createDeviceOAuth({ fetch: transport, sleep: async () => {} }),
  )
  const method = hooks.auth!.methods[0]
  if (method.type !== "oauth") throw new Error("expected OAuth")
  const flow = await method.authorize()
  if (flow.method !== "auto") throw new Error("expected automatic device flow")
  const result = await flow.callback()
  if (result.type !== "success" || !("refresh" in result)) throw new Error("expected OAuth credentials")
  expect(Auth.Oauth.make({ ...result, type: "oauth" })).toMatchObject({
    clientId: registration.clientId,
    enterpriseUrl: registration.origin,
    refresh: "",
    expires: Number.MAX_SAFE_INTEGER,
  })
  await hooks.dispose!()
  const pendingHooks = copilotAuthHooks({} as PluginInput, () => registration, createDeviceOAuth({ fetch: transport }))
  const pendingMethod = pendingHooks.auth!.methods[0]
  if (pendingMethod.type !== "oauth") throw new Error("expected OAuth")
  const pendingFlow = await pendingMethod.authorize()
  if (pendingFlow.method !== "auto") throw new Error("expected device flow")
  const rejected = pendingFlow.callback().catch((error: unknown) => error)
  await pendingHooks.dispose!()
  expect(await rejected).toBeInstanceOf(Error)
  expect(requests).toEqual(["/login/device/code", "/login/oauth/access_token", "/login/device/code"])
})
