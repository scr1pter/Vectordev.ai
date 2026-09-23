import { describe, expect, test } from "bun:test"
import {
  accessTokenIsExpiring,
  buildAuthorizeUrl,
  pollDeviceCodeToken,
  requestDeviceCode,
  XaiAuthPlugin,
} from "../../src/plugin/xai"

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

function makeServer(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: (request) => handler(request, new URL(request.url)),
  })
}

function serverOptions(server: ReturnType<typeof Bun.serve>) {
  return {
    authorizeUrl: new URL("/oauth2/authorize", server.url).toString(),
    tokenUrl: new URL("/oauth2/token", server.url).toString(),
    deviceAuthorizationUrl: new URL("/oauth2/device/code", server.url).toString(),
  }
}

describe("plugin.xai", () => {
  describe("accessTokenIsExpiring", () => {
    test("returns true for an already-expired JWT", () => {
      expect(accessTokenIsExpiring(makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }), 0)).toBe(true)
    })

    test("returns false for a fresh JWT outside the skew window", () => {
      expect(accessTokenIsExpiring(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), 0)).toBe(false)
    })

    test("honors the skew window", () => {
      const nearExpiry = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 })
      expect(accessTokenIsExpiring(nearExpiry, 60_000)).toBe(true)
      expect(accessTokenIsExpiring(nearExpiry, 0)).toBe(false)
    })

    test("clamps negative skew to zero rather than refusing to refresh", () => {
      expect(accessTokenIsExpiring(makeJwt({ exp: Math.floor(Date.now() / 1000) - 1 }), -60_000)).toBe(true)
    })

    test("returns false for opaque and malformed tokens", () => {
      expect(accessTokenIsExpiring("opaque-token-no-dots", 0)).toBe(false)
      expect(accessTokenIsExpiring("", 0)).toBe(false)
      expect(accessTokenIsExpiring(undefined, 0)).toBe(false)
      expect(accessTokenIsExpiring(makeJwt({ sub: "user-1" }), 0)).toBe(false)
      expect(accessTokenIsExpiring(makeJwt({ exp: "1234" }), 0)).toBe(false)
      expect(accessTokenIsExpiring("header.!!!not-valid-base64-or-json!!!.sig", 0)).toBe(false)
    })
  })

  describe("buildAuthorizeUrl", () => {
    const pkce = { verifier: "ver", challenge: "chal" }

    test("includes required OAuth + PKCE + OIDC params", () => {
      const url = new URL(buildAuthorizeUrl(pkce, "state-abc", "nonce-xyz"))
      const params = url.searchParams

      expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/authorize")
      expect(params.get("response_type")).toBe("code")
      expect(params.get("client_id")).toBe("")
      expect(params.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback")
      expect(params.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access")
      expect(params.get("code_challenge")).toBe("chal")
      expect(params.get("code_challenge_method")).toBe("S256")
      expect(params.get("state")).toBe("state-abc")
      expect(params.get("nonce")).toBe("nonce-xyz")
      expect(params.get("plan")).toBe("generic")
      expect(params.get("referrer")).toBe("vector")
    })

    test("supports endpoint override for local integration tests", () => {
      const url = new URL(buildAuthorizeUrl(pkce, "s", "n", { authorizeUrl: "http://127.0.0.1/oauth2/authorize" }))
      expect(url.origin + url.pathname).toBe("http://127.0.0.1/oauth2/authorize")
    })
  })

  test("offers only API keys and does not install an OAuth loader", async () => {
    const hooks = await XaiAuthPlugin({} as never)
    expect(hooks.auth?.methods.map((method) => method.type)).toEqual(["api"])
    expect(hooks.auth?.loader).toBeUndefined()
  })

  describe("device code flow", () => {
    test("requestDeviceCode posts form body, validates fields, and surfaces endpoint errors", async () => {
      let capturedBody = ""
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/missing") return Response.json({ device_code: "x" })
        if (url.pathname === "/error") return new Response("rate limited", { status: 429 })
        expect(request.method).toBe("POST")
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
        expect(request.headers.get("accept")).toBe("application/json")
        expect(request.headers.get("user-agent")).toMatch(/^vector\//)
        capturedBody = await request.text()
        return Response.json({ device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device" })
      })

      await requestDeviceCode({ deviceAuthorizationUrl: new URL("/oauth2/device/code", server.url).toString() })
      const parsed = new URLSearchParams(capturedBody)
      expect(parsed.get("client_id")).toBe("")
      expect(parsed.get("scope")).toContain("offline_access")
      expect(parsed.get("scope")).toContain("grok-cli:access")
      expect(parsed.get("scope")).toContain("api:access")
      await expect(
        requestDeviceCode({ deviceAuthorizationUrl: new URL("/error", server.url).toString() }),
      ).rejects.toThrow(/429.*rate limited/)
      await expect(
        requestDeviceCode({ deviceAuthorizationUrl: new URL("/missing", server.url).toString() }),
      ).rejects.toThrow(/missing device_code/)
    })

    test("pollDeviceCodeToken resolves on success and posts the device-code grant", async () => {
      let tokenCalls = 0
      using server = makeServer(async (request) => {
        tokenCalls++
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
        const body = new URLSearchParams(await request.text())
        expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
        expect(body.get("device_code")).toBe("DC-1")
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
      })

      const tokens = await pollDeviceCodeToken(
        { device_code: "DC-1", user_code: "UC", verification_uri: "https://x.ai/device", interval: 1, expires_in: 600 },
        { sleep: async () => {}, tokenUrl: new URL("/oauth2/token", server.url).toString() },
      )
      expect(tokens.access_token).toBe("AT")
      expect(tokens.refresh_token).toBe("RT")
      expect(tokenCalls).toBe(1)
    })

    test("pollDeviceCodeToken honors authorization_pending and slow_down", async () => {
      let n = 0
      using server = makeServer(() => {
        n++
        if (n === 1) return Response.json({ error: "authorization_pending" }, { status: 400 })
        if (n === 2) return Response.json({ error: "slow_down" }, { status: 400 })
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
      })
      const sleeps: number[] = []
      const tokens = await pollDeviceCodeToken(
        { device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device", interval: 5, expires_in: 600 },
        { sleep: async (ms) => void sleeps.push(ms), tokenUrl: new URL("/oauth2/token", server.url).toString() },
      )
      expect(tokens.access_token).toBe("AT")
      expect(n).toBe(3)
      expect(sleeps).toEqual([8_000, 13_000])
    })

    test("pollDeviceCodeToken handles terminal errors and timeout", async () => {
      for (const [body, error] of [
        [{ error: "access_denied" }, /authorization was denied/],
        [{ error: "expired_token" }, /device code expired/],
        [{ error: "server_error", error_description: "oops" }, /500.*oops/],
      ] as const) {
        using server = makeServer(() => Response.json(body, { status: 500 }))
        await expect(
          pollDeviceCodeToken(
            {
              device_code: "DC",
              user_code: "UC",
              verification_uri: "https://x.ai/device",
              interval: 1,
              expires_in: 600,
            },
            { sleep: async () => {}, tokenUrl: new URL("/oauth2/token", server.url).toString() },
          ),
        ).rejects.toThrow(error)
      }

      using pending = makeServer(() => Response.json({ error: "authorization_pending" }, { status: 400 }))
      let tick = 0
      await expect(
        pollDeviceCodeToken(
          { device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device", interval: 1, expires_in: 1 },
          {
            sleep: async () => {},
            now: () => 1_000_000 + tick++ * 600,
            tokenUrl: new URL("/oauth2/token", pending.url).toString(),
          },
        ),
      ).rejects.toThrow(/timed out/)
    })

    test("pollDeviceCodeToken normalizes bad interval and expires_in values", async () => {
      const badIntervals: Array<unknown> = [Number.NaN, "NaN", "garbage", -5, null, 0]
      for (const bad of badIntervals) {
        let n = 0
        using server = makeServer(() => {
          n++
          if (n === 1) return Response.json({ error: "authorization_pending" }, { status: 400 })
          return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
        })
        const sleeps: number[] = []
        await pollDeviceCodeToken(
          {
            device_code: "DC",
            user_code: "UC",
            verification_uri: "https://x.ai/device",
            interval: bad as number,
            expires_in: 600,
          },
          { sleep: async (ms) => void sleeps.push(ms), tokenUrl: new URL("/oauth2/token", server.url).toString() },
        )
        expect(sleeps[0]).toBe(8_000)
      }

      for (const bad of [Number.NaN, "NaN", "garbage", -5, null, 0]) {
        using server = makeServer(() => Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }))
        expect(
          (
            await pollDeviceCodeToken(
              {
                device_code: "DC",
                user_code: "UC",
                verification_uri: "https://x.ai/device",
                interval: 1,
                expires_in: bad as number,
              },
              { sleep: async () => {}, tokenUrl: new URL("/oauth2/token", server.url).toString() },
            )
          ).access_token,
        ).toBe("AT")
      }
    })
  })
})
