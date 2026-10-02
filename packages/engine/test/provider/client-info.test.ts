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
    for (const marker of ["", OAUTH_DUMMY_KEY]) {
      expect(Provider.toClientInfo(provider({ options: { apiKey: marker } })).options.apiKey).toBe(marker)
    }
  })

  test("the retired gateway marker is private like any configured key", () => {
    expect(Provider.toClientInfo(provider({ options: { apiKey: "public" } })).options.apiKey).toBeUndefined()
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

  test("drops keys from model options and headers too", () => {
    const info = Provider.toClientInfo(
      provider({
        models: {
          small: {
            id: "small",
            options: { apiKey: "secret-7", temperature: 0 },
            headers: { "x-api-key": "secret-8", "User-Agent": "vector" },
          },
        },
      }),
    )
    const text = JSON.stringify(info)
    expect(text).not.toContain("secret-7")
    expect(text).not.toContain("secret-8")
    expect(info.models.small.options.temperature).toBe(0)
    expect(info.models.small.headers["User-Agent"]).toBe("vector")
  })

  test("drops keys from model variants and masks keys in a base URL query", () => {
    const info = Provider.toClientInfo(
      provider({
        options: { baseURL: "https://api.example.com/v1?api_key=secret-9&region=us" },
        models: {
          small: { id: "small", variants: { high: { apiKey: "secret-10", reasoningEffort: "high" } } },
        },
      }),
    )
    const text = JSON.stringify(info)
    expect(text).not.toContain("secret-9")
    expect(text).not.toContain("secret-10")
    expect(info.options.baseURL).toBe("https://api.example.com/v1?api_key=[redacted]&region=us")
    expect(info.models.small.variants).toEqual({ high: { reasoningEffort: "high" } })
  })
})
