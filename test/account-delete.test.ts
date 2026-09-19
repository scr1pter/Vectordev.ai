import { afterEach, describe, expect, test } from "bun:test"
import { __test } from "../api/account/delete"
import { accountTokensRevoked, revocationConfigured, revokeAccountTokens } from "../api/_lib/revocation"

const original = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  KV_REST_API_URL: process.env.KV_REST_API_URL,
  KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
}

afterEach(() => {
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

describe("account deletion configuration", () => {
  test("refuses to consider deletion without a service-role key", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect(__test.adminConfiguration()).toBeUndefined()
  })

  test("is available once the service-role key is set", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co/"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service_role_key"
    expect(__test.adminConfiguration()).toEqual({
      url: "https://vector.supabase.co",
      serviceRole: "service_role_key",
    })
  })
})

describe("deleting the identity", () => {
  const admin = { url: "https://vector.supabase.co", serviceRole: "service_role_key" }

  test("calls Supabase's admin endpoint with the service role", async () => {
    let seen: { url: string; method?: string; apikey?: string } | undefined
    await __test.deleteAccountUser(admin, "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb", (async (url: string, init: any) => {
      seen = { url, method: init?.method, apikey: init?.headers?.apikey }
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch)
    expect(seen?.url).toBe("https://vector.supabase.co/auth/v1/admin/users/9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb")
    expect(seen?.method).toBe("DELETE")
    expect(seen?.apikey).toBe("service_role_key")
  })

  test("treats an already-missing user as deleted", async () => {
    await expect(
      __test.deleteAccountUser(admin, "gone", (async () => new Response("", { status: 404 })) as unknown as typeof fetch),
    ).resolves.toBeUndefined()
  })

  test("reports a refusal rather than claiming success", async () => {
    await expect(
      __test.deleteAccountUser(admin, "user", (async () => new Response("", { status: 500 })) as unknown as typeof fetch),
    ).rejects.toThrow(/could not delete/i)
  })
})

describe("CLI token revocation", () => {
  test("says so when no store is configured, instead of pretending", async () => {
    delete process.env.KV_REST_API_URL
    delete process.env.KV_REST_API_TOKEN
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    expect(revocationConfigured()).toBe(false)
    expect(await revokeAccountTokens("user")).toBe(false)
    expect(await accountTokensRevoked("user")).toBe(false)
  })

  test("writes the account id with an expiry longer than a token's life", async () => {
    process.env.KV_REST_API_URL = "https://kv.example.com"
    process.env.KV_REST_API_TOKEN = "kv-token"
    let seen = ""
    const ok = await revokeAccountTokens("user-1", (async (url: string) => {
      seen = url
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch)
    expect(ok).toBe(true)
    expect(seen).toContain("/set/vector%3Acli-revoked%3Auser-1/1")
    const expiry = Number(new URL(seen).searchParams.get("ex"))
    expect(expiry).toBeGreaterThan(90 * 24 * 60 * 60)
  })

  test("reads a revoked account back", async () => {
    process.env.KV_REST_API_URL = "https://kv.example.com"
    process.env.KV_REST_API_TOKEN = "kv-token"
    const revoked = await accountTokensRevoked("user-1", (async () =>
      new Response(JSON.stringify({ result: "1" }), { status: 200 })) as unknown as typeof fetch)
    expect(revoked).toBe(true)
  })

  test("fails open when the store is unreachable, so a Redis outage locks nobody out", async () => {
    process.env.KV_REST_API_URL = "https://kv.example.com"
    process.env.KV_REST_API_TOKEN = "kv-token"
    const revoked = await accountTokensRevoked("user-1", (async () => {
      throw new Error("unreachable")
    }) as unknown as typeof fetch)
    expect(revoked).toBe(false)
  })
})
