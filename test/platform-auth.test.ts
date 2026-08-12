import { afterEach, describe, expect, test } from "bun:test"
import { enabledPlatformAuthProviders } from "../api/_lib/platform"

const names = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "VECTOR_AUTH_PROVIDERS"] as const
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe("Vector account providers", () => {
  test("only advertises OAuth providers that Supabase has actually enabled", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable"
    process.env.VECTOR_AUTH_PROVIDERS = "google,github"

    const providers = await enabledPlatformAuthProviders(async () =>
      Response.json({ external: { email: true, google: true, github: false } }),
    )

    expect(providers).toEqual(["google"])
  })

  test("discovers enabled Supabase providers when no allowlist is configured", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable"
    delete process.env.VECTOR_AUTH_PROVIDERS

    const providers = await enabledPlatformAuthProviders(async () =>
      Response.json({ external: { google: true, github: true } }),
    )

    expect(providers).toEqual(["github", "google"])
  })

  test("fails closed if provider discovery is unavailable", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "publishable"
    process.env.VECTOR_AUTH_PROVIDERS = "google"

    const providers = await enabledPlatformAuthProviders(async () => {
      throw new Error("offline")
    })

    expect(providers).toEqual([])
  })
})
