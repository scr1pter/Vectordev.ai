import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OpenRouterOAuth } from "@vectordevai/core/oauth/openrouter"

test("PKCE uses a fresh RFC-compatible verifier and S256 base64url challenge", () => {
  const first = OpenRouterOAuth.createPKCE()
  const second = OpenRouterOAuth.createPKCE()
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(first.verifier).not.toBe(second.verifier)
  expect(first.challenge).toBe(createHash("sha256").update(first.verifier).digest("base64url"))
})

test("real loopback callback validates nonce and exchanges its one-time code for an API key", async () => {
  const exchanges: Array<{ url: string; body: Record<string, string> }> = []
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      exchanges.push({ url: request.url, body: await request.json() })
      return Response.json({ key: "synthetic-openrouter-key" })
    },
  })
  const attempt = await OpenRouterOAuth.authorize({
    request: (url, init) => {
      expect(url).toBe(OpenRouterOAuth.EXCHANGE_URL)
      expect(init.redirect).toBe("error")
      return fetch(new URL(new URL(url).pathname, upstream.url), init)
    },
  })
  try {
    const authorization = new URL(attempt.url)
    const callback = new URL(authorization.searchParams.get("callback_url")!)
    expect(authorization.origin + authorization.pathname).toBe(OpenRouterOAuth.AUTHORIZE_URL)
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    expect(callback.hostname).toBe("127.0.0.1")
    expect(callback.port).not.toBe("0")
    expect(callback.pathname).toBe("/callback")
    const invalid = new URL(callback)
    invalid.searchParams.set("state", "wrong-nonce")
    invalid.searchParams.set("code", "must-not-exchange")
    expect((await fetch(invalid)).status).toBe(400)
    expect(exchanges).toEqual([])
    expect((await fetch(new URL("/not-callback", callback))).status).toBe(404)
    callback.searchParams.set("code", "synthetic-code")
    const response = await fetch(callback)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Authorization received")
    expect(await attempt.key).toBe("synthetic-openrouter-key")
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].body.code).toBe("synthetic-code")
    expect(exchanges[0].body.code_challenge_method).toBe("S256")
    expect(createHash("sha256").update(exchanges[0].body.code_verifier).digest("base64url")).toBe(
      authorization.searchParams.get("code_challenge") ?? "",
    )
    expect(attempt.url).not.toContain("synthetic-openrouter-key")
    expect(attempt.url).not.toContain(exchanges[0].body.code_verifier)
    expect(new URL(exchanges[0].url).search).toBe("")
  } finally {
    attempt.close()
    await upstream.stop(true)
  }
})

test("cancelled and expired authorization attempts release their listeners", async () => {
  const cancelled = await OpenRouterOAuth.authorize()
  cancelled.close()
  await expect(cancelled.key).rejects.toThrow("cancelled")
  const expired = await OpenRouterOAuth.authorize({ timeoutMs: 5 })
  await expect(expired.key).rejects.toThrow("timed out")
})

test("exchange failures never return or disclose a key", async () => {
  await expect(
    OpenRouterOAuth.exchange("code", "verifier", async () => new Response("secret", { status: 403 })),
  ).rejects.toThrow("HTTP 403")
  await expect(OpenRouterOAuth.exchange("code", "verifier", async () => Response.json({ key: "" }))).rejects.toThrow(
    "invalid API key response",
  )
  await expect(
    OpenRouterOAuth.exchange("code", "verifier", async () => Response.json({ access_token: "must-not-be-used" })),
  ).rejects.toThrow("invalid API key response")
})

test("cancelling during key exchange aborts the request and never returns the received key", async () => {
  const entered = Promise.withResolvers<AbortSignal | null | undefined>()
  const response = Promise.withResolvers<Response>()
  const attempt = await OpenRouterOAuth.authorize({
    request: async (_url, init) => {
      entered.resolve(init.signal)
      return response.promise
    },
  })
  const callback = new URL(new URL(attempt.url).searchParams.get("callback_url") ?? "")
  callback.searchParams.set("code", "synthetic-code")
  await fetch(callback)
  const signal = await entered.promise
  attempt.close()
  expect(signal?.aborted).toBe(true)
  response.resolve(Response.json({ key: "must-not-be-stored" }))
  await expect(attempt.key).rejects.toThrow("cancelled")
})
