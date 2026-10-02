import { describe, expect, test } from "bun:test"
import os from "os"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  renderOAuthError,
  type IdTokenClaims,
} from "../../src/plugin/openai/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  test("a ChatGPT sign-in keeps every GPT-5 and GPT-6 model at no cost and drops older OpenAI models", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    const ids = ["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.5", "codex-mini-latest", "gpt-4o", "o3"]
    const provider = {
      models: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            api: { id },
            cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
            limit: { context: 1_050_000, output: 128_000 },
          },
        ]),
      ),
    }
    const models = await hooks.provider!.models!(provider as never, { auth: { type: "oauth" } } as never)
    expect(Object.keys(models).sort()).toEqual(
      ["codex-mini-latest", "gpt-5.5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"].sort(),
    )
    expect(models["gpt-6-astra"].cost.input).toBe(0)
    // The Codex backend's 272K window, not the API's 1,050,000.
    expect(models["gpt-6-astra"].limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    expect(models["gpt-6.1-sol"].limit.input).toBe(272_000)
    expect(models["codex-mini-latest"].limit.context).toBe(1_050_000)
  })

  test("escapes provider errors in callback HTML", () => {
    const error = `</div><script>alert("xss" & 'more')</script>`
    const html = renderOAuthError(error)

    expect(html).toContain("&lt;/div&gt;&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;more&#39;)&lt;/script&gt;")
    expect(html).not.toContain(error)
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  test("installs websocket transport only when experimental websockets are enabled", async () => {
    const disabled = await CodexAuthPlugin({} as never)
    const enabled = await CodexAuthPlugin({} as never, { experimentalWebSockets: true })

    const disabledOptions = await disabled.auth!.loader!(
      async () => ({ type: "api", key: "sk-test" }) as never,
      {} as never,
    )
    const enabledOptions = await enabled.auth!.loader!(
      async () => ({ type: "api", key: "sk-test" }) as never,
      {} as never,
    )

    expect(disabledOptions.fetch).toBeUndefined()
    expect(enabledOptions.fetch).toBeFunction()
    await enabled.dispose?.()
  })

  test("offers ChatGPT sign-in alongside API keys and uses a cached ChatGPT credential", async () => {
    const hooks = await CodexAuthPlugin({} as never)
    expect(hooks.auth?.methods.map((method) => method.label)).toEqual([
      "ChatGPT Pro/Plus (browser)",
      "ChatGPT Pro/Plus (headless)",
      "Manually enter API Key",
    ])
    const options = await hooks.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "placeholder",
        access: "placeholder",
        expires: 0,
      }),
      { models: {} } as never,
    )
    expect(Object.keys(options)).not.toHaveLength(0)
  })

  describe("browser sign-in callback server", () => {
    const start = async (options: Parameters<typeof CodexAuthPlugin>[1] = {}) => {
      const hooks = await CodexAuthPlugin({} as never, options)
      const method = hooks.auth!.methods[0]
      if (method.type !== "oauth") throw new Error("expected the browser OAuth method")
      const authorization = await method.authorize()
      if (authorization.method !== "auto") throw new Error("expected an automatic callback")
      return {
        state: new URL(authorization.url).searchParams.get("state")!,
        // Settle into a value right away, as the sign-in dialog awaits it, so a rejection is never unhandled.
        failure: authorization.callback().then(
          () => undefined,
          (error: Error) => error.message,
        ),
      }
    }
    const reachable = (host: string) =>
      fetch(`http://${host}:1455/`, { signal: AbortSignal.timeout(2_000) }).then(
        () => true,
        () => false,
      )

    test("listens on loopback only and closes after a provider error", async () => {
      const attempt = await start()
      expect(await reachable("127.0.0.1")).toBe(true)
      // A wildcard listen (no host) binds "::" dual-stack, which answers on IPv6 loopback too. This holds
      // on any machine, unlike the LAN check below, which needs a non-internal IPv4 address.
      expect(await reachable("[::1]")).toBe(false)
      const lan = Object.values(os.networkInterfaces())
        .flatMap((items) => items ?? [])
        .find((item) => item.family === "IPv4" && !item.internal)
      if (lan) expect(await reachable(lan.address)).toBe(false)

      const response = await fetch(
        `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${encodeURIComponent(attempt.state)}`,
      )
      expect(response.status).toBe(200)
      expect(await attempt.failure).toBe("access_denied")
      expect(await reachable("127.0.0.1")).toBe(false)
    })

    test("ignores cancel and error requests that do not carry the sign-in state", async () => {
      const attempt = await start()

      expect((await fetch("http://127.0.0.1:1455/cancel")).status).toBe(400)
      expect((await fetch("http://127.0.0.1:1455/auth/callback?error=access_denied&state=wrong")).status).toBe(400)
      expect((await fetch("http://127.0.0.1:1455/auth/callback?code=stolen")).status).toBe(400)
      expect(await Promise.race([attempt.failure, Bun.sleep(50).then(() => "pending")])).toBe("pending")

      expect((await fetch(`http://127.0.0.1:1455/cancel?state=${encodeURIComponent(attempt.state)}`)).status).toBe(200)
      expect(await attempt.failure).toBe("Login cancelled")
      expect(await reachable("127.0.0.1")).toBe(false)
    })

    test("closes after a sign-in times out", async () => {
      const attempt = await start({ callbackTimeout: 50 })
      expect(await reachable("127.0.0.1")).toBe(true)
      expect(await attempt.failure).toBe("OAuth callback timeout - authorization took too long")
      expect(await reachable("127.0.0.1")).toBe(false)
    })

    test("a newer sign-in replaces an unfinished one and keeps the server up", async () => {
      const first = await start()
      const second = await start()
      expect(await first.failure).toBe("Login cancelled")
      expect(await reachable("127.0.0.1")).toBe(true)

      await fetch(`http://127.0.0.1:1455/cancel?state=${encodeURIComponent(second.state)}`)
      expect(await second.failure).toBe("Login cancelled")
      expect(await reachable("127.0.0.1")).toBe(false)
    })
  })
})
