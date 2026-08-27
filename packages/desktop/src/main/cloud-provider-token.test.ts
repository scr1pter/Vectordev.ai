import { describe, expect, test } from "bun:test"

import { validateCloudProviderToken } from "./cloud-provider-token"

describe("manual cloud provider tokens", () => {
  test("validates provider identity with a bearer token without returning the token", async () => {
    const requests: string[] = []
    const identity = await validateCloudProviderToken("vercel", "  secret-token  ", async (input, init) => {
      requests.push(String(input))
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token")
      return Response.json({ user: { id: "user_1", username: "vector-user" } })
    })

    expect(requests).toEqual(["https://api.vercel.com/v2/user"])
    expect(identity).toEqual({ account: "vector-user", accountId: "user_1" })
    expect(JSON.stringify(identity)).not.toContain("secret-token")
  })

  test("uses each provider's own identity endpoint", async () => {
    const urls: string[] = []
    const request = async (input: string | URL | Request) => {
      urls.push(String(input))
      if (String(input).includes("netlify")) return Response.json({ id: "netlify_1", email: "dev@example.com" })
      return Response.json([{ id: "supabase_1", name: "Vector Org" }])
    }

    expect(await validateCloudProviderToken("netlify", "netlify-token", request)).toEqual({
      account: "dev@example.com",
      accountId: "netlify_1",
    })
    expect(await validateCloudProviderToken("supabase", "supabase-token", request)).toEqual({
      account: "Vector Org",
      accountId: "supabase_1",
    })
    expect(urls).toEqual(["https://api.netlify.com/api/v1/user", "https://api.supabase.com/v1/organizations"])
  })

  test("rejects invalid tokens without echoing their secret value", async () => {
    const token = "sensitive-token-value"
    const message = await validateCloudProviderToken("supabase", token, async () =>
      Response.json({ message: `Invalid ${token}` }, { status: 401 }),
    ).then(
      () => "",
      (error) => (error instanceof Error ? error.message : String(error)),
    )

    expect(message).toBe("Invalid [redacted]")
    expect(message).not.toContain(token)
  })
})
