import { describe, expect, test } from "bun:test"
import { validateCustomProvider } from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("validateCustomProvider", () => {
  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "myprovider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [{ row: "m0", id: " model-a ", name: " Model A ", err: {} }],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
    })

    expect(result.result).toEqual({
      providerID: "myprovider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("flags duplicate models and headers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "myprovider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          { row: "m0", id: "model-a", name: "Model A", err: {} },
          { row: "m1", id: "model-a", name: "Model A 2", err: {} },
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})

test("allows a new custom ID and rejects catalog, configured, and disabled IDs", () => {
  const form = {
    providerID: "ollama",
    name: "Private endpoint",
    baseURL: "http://127.0.0.1:11434/v1",
    apiKey: "test-only",
    models: [{ row: "m0", id: "local-model", name: "Local model", err: {} }],
    headers: [],
    err: {},
  }
  expect(validateCustomProvider({ form, t }).result?.providerID).toBe("ollama")
  for (const providerID of ["openai", "lmstudio", "configured", "disabled"]) {
    const result = validateCustomProvider({ form: { ...form, providerID }, existing: ["configured", "disabled"], t })
    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBe("provider.custom.error.providerID.exists")
  }
  expect(validateCustomProvider({ form: { ...form, providerID: "Not valid" }, t }).err.providerID).toBe(
    "provider.custom.error.providerID.format",
  )
})
