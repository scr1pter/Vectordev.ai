import { afterEach, describe, expect, test } from "bun:test"
import { publicAccountConfiguration, requireAccountUser } from "../api/_lib/account"

const original = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
}

afterEach(() => {
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

function request(token?: string) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} }
}

describe("Vector account authentication", () => {
  test("reports public Supabase configuration without exposing a service key", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
    expect(publicAccountConfiguration()).toEqual({
      available: true,
      url: "https://vector.supabase.co",
      publishableKey: "sb_publishable_vector",
    })
  })

  test("accepts a confirmed Supabase user", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
    const user = await requireAccountUser(request("session"), () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb",
            email: "User@Example.com",
            email_confirmed_at: "2026-09-01T12:00:00.000Z",
            user_metadata: { full_name: "Vector User" },
          }),
          { status: 200 },
        ),
      ),
    )
    expect(user).toEqual({
      id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb",
      email: "user@example.com",
      name: "Vector User",
    })
  })

  test("rejects an unconfirmed email", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
    await expect(
      requireAccountUser(request("session"), () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb",
              email: "user@example.com",
              email_confirmed_at: null,
            }),
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "EMAIL_NOT_CONFIRMED" })
  })

  test("rejects a malformed confirmation timestamp", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co/"
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
    await expect(
      requireAccountUser(request("session"), () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb",
              email: "user@example.com",
              email_confirmed_at: "not-a-date",
            }),
            { status: 200 },
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "EMAIL_NOT_CONFIRMED" })
  })

  test("rejects missing bearer credentials", async () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_vector"
    await expect(requireAccountUser(request())).rejects.toMatchObject({ statusCode: 401, code: "SIGN_IN_REQUIRED" })
  })
})
