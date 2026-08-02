import { describe, expect, test } from "bun:test"

import {
  createOAuthAuthorizeUrl,
  createOAuthCallbackResponse,
  exchangeOAuthCode,
  oauthProviderConfig,
  revokeSupabaseOAuthToken,
  verifyOAuthState,
} from "./oauth"

const requestUrl = "https://vectordev.ai/api/cloud/oauth/start"
const stateSecret = "vector-oauth-state-secret-for-tests-123456"

describe("cloud OAuth configuration", () => {
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
      { provider: "supabase", state: "state-123", codeChallenge: "challenge-123" },
      requestUrl,
      {
        VECTOR_SUPABASE_CLIENT_ID: "client-id",
        VECTOR_SUPABASE_CLIENT_SECRET: "client-secret",
        VECTOR_OAUTH_STATE_SECRET: stateSecret,
      },
    )
    const url = new URL(result.authorizeUrl)
    expect(url.origin).toBe("https://api.supabase.com")
    expect(url.searchParams.get("state")).toBe(result.state)
    expect(result.state).toStartWith("state-123~")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-123")
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://vectordev.ai/api/cloud/oauth/callback-supabase",
    )
  })

  test("builds the external Vercel integration URL", () => {
    const result = createOAuthAuthorizeUrl(
      { provider: "vercel", state: "state-123" },
      requestUrl,
      {
        VECTOR_VERCEL_INTEGRATION_SLUG: "vector",
        VECTOR_VERCEL_CLIENT_ID: "client-id",
        VECTOR_VERCEL_CLIENT_SECRET: "client-secret",
        VECTOR_OAUTH_STATE_SECRET: stateSecret,
      },
    )
    const url = new URL(result.authorizeUrl)
    expect(url.origin).toBe("https://vercel.com")
    expect(url.searchParams.get("state")).toBe(result.state)
    expect(verifyOAuthState("vercel", result.state, { VECTOR_OAUTH_STATE_SECRET: stateSecret })).toBe(true)
  })
})

describe("cloud OAuth callbacks", () => {
  test("returns a no-store page that opens Vector", async () => {
    const response = createOAuthCallbackResponse(
      "supabase",
      "https://vectordev.ai/api/cloud/oauth/callback-supabase?code=abc&state=xyz",
    )
    expect(response.headers.get("cache-control")).toContain("no-store")
    const html = await response.text()
    expect(html).toContain("vector://cloud/oauth")
    expect(html).toContain("Supabase is connected")
  })
})

describe("cloud OAuth token exchange", () => {
  test("normalizes a Vercel token response", async () => {
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.body?.toString()).toContain("client_secret=client-secret")
      return Response.json({ access_token: "token", token_type: "Bearer", team_id: "team_1" })
    }) as typeof fetch
    const result = await exchangeOAuthCode(
      {
        provider: "vercel",
        code: "code-1",
        state: createOAuthAuthorizeUrl(
          { provider: "vercel", state: "state-123" },
          requestUrl,
          {
            VECTOR_VERCEL_INTEGRATION_SLUG: "vector",
            VECTOR_VERCEL_CLIENT_ID: "client-id",
            VECTOR_VERCEL_CLIENT_SECRET: "client-secret",
            VECTOR_OAUTH_STATE_SECRET: stateSecret,
          },
        ).state,
      },
      requestUrl,
      {
        VECTOR_VERCEL_INTEGRATION_SLUG: "vector",
        VECTOR_VERCEL_CLIENT_ID: "client-id",
        VECTOR_VERCEL_CLIENT_SECRET: "client-secret",
        VECTOR_OAUTH_STATE_SECRET: stateSecret,
      },
      fetcher,
    )
    expect(result).toEqual({ accessToken: "token", tokenType: "Bearer", teamId: "team_1" })
  })

  test("rejects a tampered OAuth transaction", async () => {
    await expect(
      exchangeOAuthCode(
        { provider: "vercel", code: "code-1", state: "tampered" },
        requestUrl,
        {
          VECTOR_VERCEL_INTEGRATION_SLUG: "vector",
          VECTOR_VERCEL_CLIENT_ID: "client-id",
          VECTOR_VERCEL_CLIENT_SECRET: "client-secret",
          VECTOR_OAUTH_STATE_SECRET: stateSecret,
        },
      ),
    ).rejects.toThrow("invalid or expired")
  })

  test("revokes Supabase consent with the registered OAuth app", async () => {
    let request: { url?: string; body?: unknown } = {}
    await revokeSupabaseOAuthToken(
      "refresh-token",
      requestUrl,
      {
        VECTOR_SUPABASE_CLIENT_ID: "client-id",
        VECTOR_SUPABASE_CLIENT_SECRET: "client-secret",
        VECTOR_OAUTH_STATE_SECRET: stateSecret,
      },
      (async (input, init) => {
        request = { url: String(input), body: init?.body }
        return new Response(null, { status: 204 })
      }) as typeof fetch,
    )
    expect(request.url).toBe("https://api.supabase.com/v1/oauth/revoke")
    expect(JSON.parse(String(request.body))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token",
    })
  })
})
