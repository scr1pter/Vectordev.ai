import { afterEach, describe, expect, test } from "bun:test"
import { buildBuilderConfig, requiredBuilderModel } from "../api/_lib/builder-agent"
import { createComputerToken, verifyComputerToken } from "../api/_lib/companion"
import { cleanProviderModels, providerModelId } from "../api/_lib/provider-catalog"
import { platformConfiguration } from "../api/_lib/platform"

describe("Vector Builder model routing", () => {
  const originalModels = process.env.VECTOR_BUILDER_MODELS
  const originalModel = process.env.VECTOR_BUILDER_MODEL
  const platformEnvironment = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "VECTOR_PLATFORM_SECRET",
    "OPENROUTER_API_KEY",
    "VECTOR_BUILDER_SANDBOX_IMAGE",
    "CRON_SECRET",
  ] as const
  const originals = Object.fromEntries(platformEnvironment.map((name) => [name, process.env[name]]))

  afterEach(() => {
    if (originalModels === undefined) delete process.env.VECTOR_BUILDER_MODELS
    else process.env.VECTOR_BUILDER_MODELS = originalModels
    if (originalModel === undefined) delete process.env.VECTOR_BUILDER_MODEL
    else process.env.VECTOR_BUILDER_MODEL = originalModel
    for (const name of platformEnvironment) {
      const value = originals[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test("registers the selected OpenRouter model with the agent engine", () => {
    const config = buildBuilderConfig(
      { browser: { type: "local", command: ["playwright-mcp"] } },
      "openrouter/poolside/laguna-s-2.1:free",
    )

    expect(config.enabled_providers).toEqual(["openrouter"])
    expect(config.provider.openrouter.models).toEqual({ "poolside/laguna-s-2.1:free": {} })
    expect(config.provider.openrouter.options.headers).toEqual({
      "HTTP-Referer": "https://vectordev.ai",
      "X-OpenRouter-Title": "Vector Builder",
    })
    expect(config.mcp).toHaveProperty("browser")
    expect(config.permission.bash["git push *"]).toBe("deny")
  })

  test("accepts only server-configured OpenRouter models", () => {
    process.env.VECTOR_BUILDER_MODELS =
      "openrouter/poolside/laguna-s-2.1:free,openrouter/cohere/north-mini-code:free,vercel/direct-model"
    delete process.env.VECTOR_BUILDER_MODEL

    expect(requiredBuilderModel()).toBe("openrouter/poolside/laguna-s-2.1:free")
    expect(requiredBuilderModel("openrouter/cohere/north-mini-code:free")).toBe(
      "openrouter/cohere/north-mini-code:free",
    )
    expect(() => requiredBuilderModel("vercel/direct-model")).toThrow("Choose an available Vector Builder model")
  })

  test("builds native provider configuration for BYOK models", () => {
    const config = buildBuilderConfig({}, "anthropic/claude-sonnet-4-5", "anthropic")
    expect(config.enabled_providers).toEqual(["anthropic"])
    expect(config.provider.anthropic.models).toEqual({ "claude-sonnet-4-5": {} })
    expect(config.provider.anthropic).not.toHaveProperty("options")
  })

  test("normalizes provider model IDs without losing nested model names", () => {
    expect(cleanProviderModels("groq", ["groq/openai/gpt-oss-120b", "qwen/qwen3-32b"])).toEqual([
      "openai/gpt-oss-120b",
      "qwen/qwen3-32b",
    ])
    expect(providerModelId("groq", "openai/gpt-oss-120b")).toBe("groq/openai/gpt-oss-120b")
  })

  test("signs Builder computer access to one run and device", () => {
    process.env.VECTOR_PLATFORM_SECRET = "s".repeat(32)
    const token = createComputerToken({ userId: "user", runId: "run", deviceId: "device" })
    expect(verifyComputerToken(token)).toMatchObject({ userId: "user", runId: "run", deviceId: "device" })
    expect(() => verifyComputerToken(`${token}tampered`)).toThrow("invalid")
  })

  test("does not advertise Builder without the pinned runtime and reconciler", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role"
    process.env.VECTOR_PLATFORM_SECRET = "v".repeat(32)
    process.env.OPENROUTER_API_KEY = "gateway"
    process.env.VECTOR_BUILDER_MODELS = "openrouter/poolside/laguna-s-2.1:free"
    delete process.env.VECTOR_BUILDER_SANDBOX_IMAGE
    delete process.env.CRON_SECRET

    expect(platformConfiguration().builderAvailable).toBe(false)

    process.env.VECTOR_BUILDER_SANDBOX_IMAGE = "vcr.vercel.com/vector/builder:1.59.1"
    process.env.CRON_SECRET = "c".repeat(24)
    expect(platformConfiguration().builderAvailable).toBe(true)
  })
})
