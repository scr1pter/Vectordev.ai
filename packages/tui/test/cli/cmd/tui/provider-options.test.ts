import { describe, expect, test } from "bun:test"
import { normalizeCustomProviderID, providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("includes a synthetic Other option for custom providers", () => {
    expect(providerOptions([{ id: "openai", name: "OpenAI" }]).at(-1)).toMatchObject({
      title: "Other",
      description: "New custom provider credential",
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

  test("includes configured custom providers without colliding with Other", () => {
    const values = providerOptions([{ id: "other", name: "Other Provider", source: "config" }]).map(
      (option) => option.value,
    )
    expect(values).toContain("other")
    expect(new Set(values).size).toBe(values.length)
  })

  test("paused Copilot is excluded even when an older server supplies its config or environment entry", () => {
    expect(
      providerOptions([
        { id: "github-copilot", name: "GitHub Copilot", source: "env" },
        { id: "github-copilot-enterprise", name: "Copilot Enterprise", source: "config" },
        { id: "openai", name: "OpenAI", source: "env" },
      ]).map((provider) => provider.value),
    ).toEqual(["openai", "__vector_custom_provider__"])
  })

  test("normalizes and validates custom provider ids", () => {
    expect(normalizeCustomProviderID("  ollama  ")).toBe("ollama")
    expect(normalizeCustomProviderID("custom_provider")).toBe("custom_provider")
    expect(normalizeCustomProviderID("@ai-sdk/openai")).toBeUndefined()
    expect(normalizeCustomProviderID("custom-provider")).toBe("custom-provider")
    expect(normalizeCustomProviderID("configured", ["configured"])).toBeUndefined()
    expect(normalizeCustomProviderID("lmstudio")).toBeUndefined()
    expect(normalizeCustomProviderID("-custom-provider")).toBeUndefined()
    expect(normalizeCustomProviderID("Custom Provider")).toBeUndefined()
  })

  test("an approved plugin is listed without opening the generic custom-provider gate", () => {
    expect(
      providerOptions([
        { id: "github-copilot", name: "Approved plugin", options: { vectorOAuthPlugin: "a".repeat(64) } },
        { id: "github-copilot-enterprise", name: "Unapproved plugin", options: { vectorOAuthPlugin: "yes" } },
      ]).map((option) => option.value),
    ).toEqual(["github-copilot", "__vector_custom_provider__"])
    expect(normalizeCustomProviderID("github-copilot")).toBeUndefined()
  })
})
