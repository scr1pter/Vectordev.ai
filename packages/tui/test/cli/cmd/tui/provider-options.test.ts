import { describe, expect, test } from "bun:test"
import { normalizeCustomProviderID, providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("includes a synthetic Other option for custom providers", () => {
    expect(providerOptions([{ id: "openai", name: "OpenAI" }]).at(-1)).toMatchObject({
      title: "Other",
      description: "Supported provider credential",
      category: "Providers",
    })
  })

  test("does not use Other as the generic provider category", () => {
    expect(providerOptions([{ id: "mistral", name: "Mistral" }])[0]?.category).toBe("Providers")
  })

  test("keeps popular providers first and sorts the rest alphabetically", () => {
    expect(
      providerOptions([
        { id: "openai", name: "OpenAI" },
        { id: "zai", name: "Z.AI" },
        { id: "custom-z", name: "Unsupported provider" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "amazon-bedrock", name: "AWS Bedrock" },
      ]).map((option) => option.value),
    ).toEqual(["openai", "anthropic", "amazon-bedrock", "mistral", "zai", "__vector_custom_provider__"])
  })

  test("does not collide with a configured provider named other", () => {
    const values = providerOptions([{ id: "other", name: "Other Provider" }]).map((option) => option.value)
    expect(new Set(values).size).toBe(values.length)
  })

  test("normalizes and validates custom provider ids", () => {
    expect(normalizeCustomProviderID("  lmstudio  ")).toBe("lmstudio")
    expect(normalizeCustomProviderID("custom_provider")).toBeUndefined()
    expect(normalizeCustomProviderID("@ai-sdk/openai")).toBe("openai")
    expect(normalizeCustomProviderID("custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("-custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("Custom Provider")).toBeUndefined()
  })
})
