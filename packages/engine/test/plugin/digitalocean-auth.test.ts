import { expect, test } from "bun:test"
import { digitalOceanOAuthConfiguration } from "@vectordevai/core/provider-policy"
import { createDigitalOceanOAuth } from "@vectordevai/core/oauth/digitalocean"
import { Auth } from "../../src/auth"
import { digitalOceanAuthHooks } from "../../src/plugin/digitalocean"

const registration = {
  ...digitalOceanOAuthConfiguration({ VECTOR_DIGITALOCEAN_OAUTH_CLIENT_ID: "vector-test-client" }, true)!,
  redirectUri: "http://localhost:0/auth/callback",
}
test("legacy DigitalOcean callback stores expiring owned OAuth and discovery preserves base models", async () => {
  using server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ model_routers: [{ name: "fixture-router" }] })
    },
  })
  const oauth = createDigitalOceanOAuth({
    fetch: Object.assign((_input: RequestInfo | URL, init?: RequestInit) => fetch(server.url, init), {
      preconnect: fetch.preconnect,
    }),
  })
  const hooks = digitalOceanAuthHooks(() => registration, oauth)
  try {
    const method = hooks.auth!.methods[0]
    if (method.type !== "oauth") throw new Error("expected OAuth")
    const flow = await method.authorize()
    if (flow.method !== "auto") throw new Error("expected automatic flow")
    const url = new URL(flow.url)
    const redirect = new URL(url.searchParams.get("redirect_uri")!)
    await fetch(new URL("/auth/token", redirect), {
      method: "POST",
      headers: { "content-type": "application/json", origin: redirect.origin },
      body: JSON.stringify({
        access_token: "synthetic-token",
        expires_in: 3600,
        token_type: "bearer",
        state: url.searchParams.get("state"),
      }),
    })
    const result = await flow.callback()
    if (result.type !== "success" || !("refresh" in result)) throw new Error("expected OAuth")
    const credential = Auth.Oauth.make({ ...result, type: "oauth" })
    expect(credential.clientId).toBe(registration.clientId)
    const models = await hooks.provider!.models!(
      { models: { baseline: { id: "baseline" } } } as never,
      { auth: credential } as never,
    )
    expect(models.baseline.id).toBe("baseline")
    expect(models["router:fixture-router"].api.url).toBe("https://inference.do-ai.run/v1")
    const loaded = await hooks.auth!.loader!(async () => ({ ...credential, expires: 0 }), {} as never)
    await expect(loaded.fetch("https://inference.do-ai.run/v1/chat/completions")).rejects.toThrow("sign-in expired")
    await expect(loaded.fetch("https://attacker.test/chat/completions")).rejects.toThrow("different provider origin")
  } finally {
    await hooks.dispose!()
  }
})
