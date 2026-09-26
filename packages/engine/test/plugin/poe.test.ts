import { expect, test } from "bun:test"
import { poeOAuthConfiguration } from "@vectordevai/core/provider-policy"
import { createPoeOAuth } from "@vectordevai/core/oauth/poe"
import { Auth } from "../../src/auth"
import { PoeAuthPlugin, poeAuthHooks } from "../../src/plugin/poe"

const registration = poeOAuthConfiguration({ VECTOR_POE_OAUTH_CLIENT_ID: "vector-test-client" }, true)!
test("Poe remains API-key-only in the shipping build", async () => {
  const hooks = await PoeAuthPlugin()
  expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
  await hooks.dispose!()
})
test("legacy Poe PKCE stores delegated key and expiry, enforcing expiry and origin at use", async () => {
  using server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ api_key: "synthetic-poe-key", api_key_expires_in: 60 })
    },
  })
  const oauth = createPoeOAuth({
    now: () => 1000,
    fetch: Object.assign((_input: RequestInfo | URL, init?: RequestInit) => fetch(server.url, init), {
      preconnect: fetch.preconnect,
    }),
  })
  const hooks = poeAuthHooks(() => registration, oauth)
  try {
    const method = hooks.auth!.methods[0]
    if (method.type !== "oauth") throw new Error("expected OAuth")
    const flow = await method.authorize()
    if (flow.method !== "auto") throw new Error("expected automatic flow")
    const url = new URL(flow.url)
    const callback = new URL(url.searchParams.get("redirect_uri")!)
    callback.search = new URLSearchParams({ state: url.searchParams.get("state")!, code: "synthetic-code" }).toString()
    await fetch(callback)
    const result = await flow.callback()
    if (result.type !== "success" || !("refresh" in result)) throw new Error("expected credential")
    const credential = Auth.Oauth.make({ ...result, type: "oauth" })
    expect(credential).toMatchObject({
      access: "synthetic-poe-key",
      expires: 61_000,
      clientId: registration.clientId,
      enterpriseUrl: registration.origin,
    })
    const loaded = await hooks.auth!.loader!(async () => credential, {} as never)
    await expect(loaded.fetch("https://api.poe.com/v1/chat/completions")).rejects.toThrow("delegated key expired")
    await expect(loaded.fetch("https://foreign.test/v1/chat/completions")).rejects.toThrow("different provider origin")
    expect(await hooks.auth!.loader!(async () => ({ ...credential, clientId: "foreign-client" }), {} as never)).toEqual(
      {},
    )
  } finally {
    await hooks.dispose!()
  }
})
