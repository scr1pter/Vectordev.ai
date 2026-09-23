import { describe, expect, test } from "bun:test"
import { OAUTH_DUMMY_KEY } from "../../src/auth"
import { Provider } from "../../src/provider/provider"

type Info = Parameters<typeof Provider.toClientInfo>[0]

const provider = (overrides: Record<string, unknown>) =>
  ({ id: "example", name: "Example", source: "api", env: [], models: {}, options: {}, ...overrides }) as unknown as Info

describe("Provider.toClientInfo", () => {
  test("never sends the stored API key", () => {
    const info = Provider.toClientInfo(
      provider({ key: "sk-real-secret", options: { apiKey: "sk-real-secret", baseURL: "https://api.example.com" } }),
    )
    expect(JSON.stringify(info)).not.toContain("sk-real-secret")
    expect(info.options.baseURL).toBe("https://api.example.com")
  })

  test("keeps the sign-in markers clients use to tell a plan from a key", () => {
    for (const marker of ["", "public", OAUTH_DUMMY_KEY]) {
      expect(Provider.toClientInfo(provider({ options: { apiKey: marker } })).options.apiKey).toBe(marker)
    }
  })

  test("drops nested credentials and auth headers but keeps ordinary options", () => {
    const info = Provider.toClientInfo(
      provider({
        options: {
          headers: { Authorization: "Bearer secret-1", "x-api-key": "secret-2", "User-Agent": "vector" },
          googleAuthOptions: { credentials: { private_key: "secret-3", client_email: "someone@example.com" } },
          secretAccessKey: "secret-4",
          accessKeyId: "secret-5",
          sessionToken: "secret-6",
          maxTokens: 4096,
        },
      }),
    )
    const text = JSON.stringify(info)
    for (const secret of ["secret-1", "secret-2", "secret-3", "secret-4", "secret-5", "secret-6"]) {
      expect(text).not.toContain(secret)
    }
    expect(info.options.headers["User-Agent"]).toBe("vector")
    expect(info.options.maxTokens).toBe(4096)
  })
})
