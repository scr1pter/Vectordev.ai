import { describe, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto"
import { runInNewContext } from "node:vm"
import { createCloudOAuthRelay, readCloudOAuthCallback } from "../../desktop/src/main/cloud-oauth-relay"
import {
  createOAuthAuthorizeUrl,
  createOAuthCallbackResponse,
  exchangeOAuthCode,
  oauthProviderConfig,
  revokeSupabaseOAuthToken,
  refreshSupabaseOAuthToken,
  signOAuthState,
  verifyOAuthState,
} from "./oauth"

const requestUrl = "https://vectordev.ai/api/cloud/oauth/start"
const stateSecret = "vector-oauth-state-secret-for-tests-123456"
const relay = createCloudOAuthRelay()
const verifier = "v".repeat(64)
const challenge = createHash("sha256").update(verifier).digest("base64url")
const credentials = {
  VECTOR_VERCEL_INTEGRATION_SLUG: "vector",
  VECTOR_VERCEL_CLIENT_ID: "client-id",
  VECTOR_VERCEL_CLIENT_SECRET: "client-secret",
  VECTOR_NETLIFY_CLIENT_ID: "client-id",
  VECTOR_SUPABASE_CLIENT_ID: "client-id",
  VECTOR_SUPABASE_CLIENT_SECRET: "client-secret",
  VECTOR_OAUTH_STATE_SECRET: stateSecret,
}

// Execute the actual hosted page with Web Crypto, without replacing process globals.
async function browserCallback(provider: "vercel" | "netlify", input: URL) {
  const html = await createOAuthCallbackResponse(provider, input.toString()).text()
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
  if (!script) throw new Error("The callback page is missing its relay script.")
  const output = { link: "", status: "", detail: "" }
  await runInNewContext(script, {
    location: input,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    TextEncoder,
    atob,
    btoa,
    document: {
      getElementById(id: string) {
        if (id === "status")
          return {
            set textContent(value: string) {
              output.status = value
            },
          }
        if (id === "detail")
          return {
            set textContent(value: string) {
              output.detail = value
            },
          }
        return {
          setAttribute(_name: string, value: string) {
            output.link = value
          },
        }
      },
    },
    setTimeout(callback: () => void) {
      callback()
    },
  })
  return { ...output, url: new URL(output.link), location: input }
}

describe("cloud OAuth configuration", () => {
  test("the status route preserves legacy manual tokens unless the desktop supports the secure relay", async () => {
    // Run the actual route with only synthetic environment values, never host credentials.
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
const { GET } = await import(${JSON.stringify(new URL("../../../api/cloud/oauth/status.ts", import.meta.url).href)})
const results = []
for (const query of ["", "?relay=unknown", "?relay=v1"]) {
  const response = GET(new Request("https://vectordev.ai/api/cloud/oauth/status" + query))
  results.push({ status: response.status, body: await response.json() })
}
delete process.env.VECTOR_VERCEL_CLIENT_SECRET
results.push({ body: await GET(new Request("https://vectordev.ai/api/cloud/oauth/status?relay=v1")).json() })
await Bun.write(Bun.stdout, JSON.stringify(results))
`,
      ],
      { env: credentials, stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000) },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const results = JSON.parse(stdout)
    for (const [index, compatible] of [false, false, true].entries()) {
      expect(results[index]).toEqual({
        status: 200,
        body: {
          ok: true,
          providers: ["vercel", "netlify", "supabase"].map((provider) => ({
            provider,
            configured: provider === "supabase" || compatible,
            callbackUrl: `https://vectordev.ai/api/cloud/oauth/callback-${provider}`,
            missing: [],
          })),
        },
      })
    }
    expect(results[3].body.providers[0]).toEqual({
      provider: "vercel",
      configured: false,
      callbackUrl: "https://vectordev.ai/api/cloud/oauth/callback-vercel",
      missing: ["VECTOR_VERCEL_CLIENT_SECRET"],
    })
  })

  test("reports missing provider credentials without exposing values", () => {
    expect(oauthProviderConfig("vercel", requestUrl, {}).missing).toEqual([
      "VECTOR_OAUTH_STATE_SECRET",
      "VECTOR_VERCEL_INTEGRATION_SLUG",
      "VECTOR_VERCEL_CLIENT_ID",
      "VECTOR_VERCEL_CLIENT_SECRET",
    ])
  })

  test("builds a Supabase PKCE authorization URL", () => {
    const result = createOAuthAuthorizeUrl(
      { provider: "supabase", state: "state-123", codeChallenge: challenge },
      requestUrl,
      credentials,
    )
    const url = new URL(result.authorizeUrl)
    expect(url.origin).toBe("https://api.supabase.com")
    expect(url.searchParams.get("state")).toBe(result.state)
    expect(result.state).toStartWith("state-123~")
    expect(url.searchParams.get("code_challenge")).toBe(challenge)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toBe("https://vectordev.ai/api/cloud/oauth/callback-supabase")
  })

  test("builds the external Vercel integration URL", () => {
    const result = createOAuthAuthorizeUrl({ provider: "vercel", state: relay.state }, requestUrl, credentials)
    const url = new URL(result.authorizeUrl)
    expect(url.origin).toBe("https://vercel.com")
    expect(url.searchParams.get("state")).toBe(result.state)
    expect(verifyOAuthState("vercel", result.state, credentials)).toBe(true)
  })

  test("does not report readiness for a state secret that signing rejects", () => {
    const env = { ...credentials, VECTOR_OAUTH_STATE_SECRET: "short" }
    expect(oauthProviderConfig("supabase", requestUrl, env)).toMatchObject({
      configured: false,
      missing: ["VECTOR_OAUTH_STATE_SECRET"],
    })
    expect(() =>
      createOAuthAuthorizeUrl({ provider: "supabase", state: "state", codeChallenge: challenge }, requestUrl, env),
    ).toThrow("not configured")
  })

  test.each([undefined, "short", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "=", " " + challenge])(
    "rejects malformed S256 challenge %s",
    (codeChallenge) => {
      expect(() =>
        createOAuthAuthorizeUrl({ provider: "supabase", state: "state", codeChallenge }, requestUrl, credentials),
      ).toThrow("valid S256")
    },
  )

  test.each(["vercel", "netlify"] as const)("requires a desktop relay key for %s", (provider) => {
    expect(() => createOAuthAuthorizeUrl({ provider, state: "legacy-state" }, requestUrl, credentials)).toThrow(
      "secure desktop OAuth relay key",
    )
    expect(() =>
      createOAuthAuthorizeUrl({ provider, state: relay.state.replace(".v1.", ".") }, requestUrl, credentials),
    ).toThrow("Update Vector")
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" })
    expect(() =>
      createOAuthAuthorizeUrl(
        { provider, state: `${"n".repeat(43)}.v1.${Buffer.from(JSON.stringify(weak)).toString("base64url")}` },
        requestUrl,
        credentials,
      ),
    ).toThrow("2048 to 4096")
  })
})

describe("cloud OAuth callbacks", () => {
  test("returns a no-store page that opens Vector without claiming connection prematurely", async () => {
    const response = createOAuthCallbackResponse(
      "supabase",
      "https://vectordev.ai/api/cloud/oauth/callback-supabase?code=abc&state=xyz",
    )
    expect(response.headers.get("cache-control")).toContain("no-store")
    const html = await response.text()
    expect(html).toContain("vector://cloud/oauth")
    expect(html).toContain("Finish connecting Supabase")
    expect(html).not.toContain("is connected")
  })

  test("shows a failed callback when Supabase omits authorization", async () => {
    const html = await createOAuthCallbackResponse(
      "supabase",
      "https://vectordev.ai/api/cloud/oauth/callback-supabase?state=state",
    ).text()
    expect(html).toContain("Connection was not completed")
    expect(html).not.toContain("is connected")
  })

  test.each(["vercel", "netlify"] as const)(
    "encrypts %s authorization for the initiating desktop only",
    async (provider) => {
      const state = createOAuthAuthorizeUrl({ provider, state: relay.state }, requestUrl, credentials).state
      const input = new URL(`https://vectordev.ai/api/cloud/oauth/callback-${provider}`)
      const values = new URLSearchParams({
        state,
        [provider === "vercel" ? "code" : "access_token"]: "secret-authorization".repeat(150),
        teamId: "team_1",
        configurationId: "config_1",
      })
      if (provider === "netlify") input.hash = values.toString()
      if (provider === "vercel") input.search = values.toString()
      const result = await browserCallback(provider, input)
      expect(result.url.searchParams.get("state")).toBe(state)
      expect(result.url.searchParams.get("encrypted")).toBeTruthy()
      expect(result.url.searchParams.has("code")).toBe(false)
      expect(result.url.searchParams.has("access_token")).toBe(false)
      expect(result.link).not.toContain("secret-authorization".repeat(150))
      expect(result.url.searchParams.get("teamId")).toBe("team_1")
      expect(result.url.searchParams.get("configurationId")).toBe("config_1")
      expect(result.location.href).toBe(result.link)
      for (const index of [1, 2, 3]) {
        const tampered = new URL(result.link)
        const parts = tampered.searchParams.get("encrypted")!.split(".")
        const bytes = Buffer.from(parts[index], "base64url")
        bytes[0] ^= 1
        parts[index] = bytes.toString("base64url")
        tampered.searchParams.set("encrypted", parts.join("."))
        expect(() => readCloudOAuthCallback(provider, tampered, { state, privateKey: relay.privateKey })).toThrow()
      }
      expect(readCloudOAuthCallback(provider, result.url, { state, privateKey: relay.privateKey })).toBe(
        "secret-authorization".repeat(150),
      )
      expect(() =>
        readCloudOAuthCallback(provider, result.url, { state, privateKey: createCloudOAuthRelay().privateKey }),
      ).toThrow()
      expect(() =>
        readCloudOAuthCallback(provider === "vercel" ? "netlify" : "vercel", result.url, {
          state,
          privateKey: relay.privateKey,
        }),
      ).toThrow()
      expect(() =>
        readCloudOAuthCallback(provider, result.url, { state: "other-state", privateKey: relay.privateKey }),
      ).toThrow("security state")
    },
  )

  test.each(["vercel", "netlify"] as const)("preserves state when %s consent is denied", async (provider) => {
    const state = signOAuthState(provider, relay.state, credentials)
    const input = new URL(`https://vectordev.ai/api/cloud/oauth/callback-${provider}`)
    const values = new URLSearchParams({ state, error: "access_denied" })
    if (provider === "netlify") input.hash = values.toString()
    if (provider === "vercel") input.search = values.toString()
    const result = await browserCallback(provider, input)
    expect(result.url.searchParams.get("state")).toBe(state)
    expect(result.url.searchParams.get("error")).toBe("access_denied")
    expect(result.status).toBe("Connection was not completed")
    expect(result.url.searchParams.has("encrypted")).toBe(false)
    expect(() => readCloudOAuthCallback(provider, result.url, { state })).toThrow("access_denied")
    expect(() => readCloudOAuthCallback(provider, result.url, { state: "other-state" })).toThrow("security state")
  })

  test.each(["vercel", "netlify"] as const)(
    "does not fall back to plaintext when the %s relay is missing",
    async (provider) => {
      const input = new URL(`https://vectordev.ai/api/cloud/oauth/callback-${provider}`)
      const values = new URLSearchParams({
        state: "legacy-state",
        [provider === "vercel" ? "code" : "access_token"]: "secret-authorization".repeat(150),
      })
      if (provider === "netlify") input.hash = values.toString()
      if (provider === "vercel") input.search = values.toString()
      const result = await browserCallback(provider, input)
      expect(result.url.searchParams.get("error")).toContain("secure return state")
      expect(result.link).not.toContain("secret-authorization".repeat(150))
      const plain = new URL("vector://cloud/oauth?state=state&code=plain&access_token=plain")
      expect(() => readCloudOAuthCallback(provider, plain, { state: "state", privateKey: relay.privateKey })).toThrow(
        "secure authorization result",
      )
    },
  )
})

describe("cloud OAuth token exchange", () => {
  test("normalizes a Vercel token response", async () => {
    const result = await exchangeOAuthCode(
      {
        provider: "vercel",
        code: "code-1",
        state: createOAuthAuthorizeUrl({ provider: "vercel", state: relay.state }, requestUrl, credentials).state,
      },
      requestUrl,
      credentials,
      async (_url, init) => {
        expect(init?.body?.toString()).toContain("client_secret=client-secret")
        return Response.json({ access_token: "token", token_type: "Bearer", team_id: "team_1" })
      },
    )
    expect(result).toEqual({ accessToken: "token", tokenType: "Bearer", teamId: "team_1" })
  })

  test("rejects a tampered OAuth transaction before provider requests", async () => {
    const requests: string[] = []
    await expect(
      exchangeOAuthCode(
        { provider: "vercel", code: "code-1", state: "tampered" },
        requestUrl,
        credentials,
        async (input) => {
          requests.push(String(input))
          throw new Error("Unexpected provider request")
        },
      ),
    ).rejects.toThrow("invalid or expired")
    expect(requests).toEqual([])
  })

  test.each([undefined, "short", "v".repeat(129), "v".repeat(42) + "+", " " + verifier])(
    "rejects malformed verifier without a provider request %s",
    async (codeVerifier) => {
      const requests: string[] = []
      await expect(
        exchangeOAuthCode(
          { provider: "supabase", state: signOAuthState("supabase", "state", credentials), code: "code", codeVerifier },
          requestUrl,
          credentials,
          async (input) => {
            requests.push(String(input))
            throw new Error("Unexpected provider request")
          },
        ),
      ).rejects.toThrow("PKCE verifier is invalid")
      expect(requests).toEqual([])
    },
  )

  test("sends a valid verifier in the actual Supabase token exchange", async () => {
    const requests: URLSearchParams[] = []
    const token = await exchangeOAuthCode(
      {
        provider: "supabase",
        state: signOAuthState("supabase", "state", credentials),
        code: "code",
        codeVerifier: verifier,
      },
      requestUrl,
      credentials,
      async (_input, init) => {
        requests.push(new URLSearchParams(String(init?.body)))
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
        )
        return Response.json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 })
      },
    )
    expect(requests[0].get("code_verifier")).toBe(verifier)
    expect(token).toMatchObject({ accessToken: "access-token", refreshToken: "refresh-token", expiresIn: 3600 })
  })

  test("revokes Supabase consent with the registered OAuth app", async () => {
    const requests: { url: string; body: unknown }[] = []
    await revokeSupabaseOAuthToken("refresh-token", requestUrl, credentials, async (input, init) => {
      requests.push({ url: String(input), body: init?.body })
      return new Response(null, { status: 204 })
    })
    expect(requests[0].url).toBe("https://api.supabase.com/v1/oauth/revoke")
    expect(JSON.parse(String(requests[0].body))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
    })
  })
})

describe("OAuth credential redirects", () => {
  test.each(["vercel", "supabase", "refresh", "revoke"] as const)("refuses redirects during %s", async (operation) => {
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        requests.push(url.pathname)
        if (url.pathname === "/redirect") return Response.redirect(new URL("/credential-sink", url).toString(), 307)
        return Response.json({ access_token: "redirected-token" })
      },
    })
    const request = (_input: string | URL | Request, init?: RequestInit) =>
      fetch(new URL("/redirect", server.url), init)
    const operations = {
      vercel: () =>
        exchangeOAuthCode(
          { provider: "vercel", state: signOAuthState("vercel", relay.state, credentials), code: "fixture-code" },
          requestUrl,
          credentials,
          request,
        ),
      supabase: () =>
        exchangeOAuthCode(
          {
            provider: "supabase",
            state: signOAuthState("supabase", "state", credentials),
            code: "fixture-code",
            codeVerifier: verifier,
          },
          requestUrl,
          credentials,
          request,
        ),
      refresh: () => refreshSupabaseOAuthToken("fixture-refresh-token", requestUrl, credentials, request),
      revoke: () => revokeSupabaseOAuthToken("fixture-refresh-token", requestUrl, credentials, request),
    }
    try {
      await expect(operations[operation]()).rejects.toThrow()
      expect(requests).toEqual(["/redirect"])
    } finally {
      await server.stop(true)
    }
  })
})
