import { afterEach, describe, expect, test } from "bun:test"
import { buildCloudAgentConfig, requiredCloudModel } from "../api/_lib/cloud-agent"
import { platformConfiguration } from "../api/_lib/platform"

describe("Vector Cloud Agent gateway configuration", () => {
  const originalModels = process.env.VECTOR_CLOUD_AGENT_MODELS
  const originalModel = process.env.VECTOR_CLOUD_AGENT_MODEL
  const platformEnvironment = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "VECTOR_PLATFORM_SECRET",
    "AI_GATEWAY_API_KEY",
    "VECTOR_CLOUD_SANDBOX_IMAGE",
    "CRON_SECRET",
  ] as const
  const originals = Object.fromEntries(platformEnvironment.map((name) => [name, process.env[name]]))

  afterEach(() => {
    if (originalModels === undefined) delete process.env.VECTOR_CLOUD_AGENT_MODELS
    else process.env.VECTOR_CLOUD_AGENT_MODELS = originalModels
    if (originalModel === undefined) delete process.env.VECTOR_CLOUD_AGENT_MODEL
    else process.env.VECTOR_CLOUD_AGENT_MODEL = originalModel
    for (const name of platformEnvironment) {
      const value = originals[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test("registers the selected AI Gateway model with the agent engine", () => {
    const config = buildCloudAgentConfig(
      { browser: { type: "local", command: ["playwright-mcp"] } },
      "vercel/anthropic/claude-sonnet-4.5",
    )

    expect(config.enabled_providers).toEqual(["vercel"])
    expect(config.provider.vercel.models).toEqual({ "anthropic/claude-sonnet-4.5": {} })
    expect(config.mcp).toHaveProperty("browser")
    expect(config.permission.bash["git push *"]).toBe("deny")
  })

  test("accepts only server-configured gateway models", () => {
    process.env.VECTOR_CLOUD_AGENT_MODELS =
      "vercel/anthropic/claude-sonnet-4.5,vercel/openai/gpt-5.4-mini,openai/direct-model"
    delete process.env.VECTOR_CLOUD_AGENT_MODEL

    expect(requiredCloudModel()).toBe("vercel/anthropic/claude-sonnet-4.5")
    expect(requiredCloudModel("vercel/openai/gpt-5.4-mini")).toBe("vercel/openai/gpt-5.4-mini")
    expect(() => requiredCloudModel("openai/direct-model")).toThrow("Choose an available Vector cloud model")
  })

  test("does not advertise Cloud Agents without the pinned runtime and reconciler", () => {
    process.env.SUPABASE_URL = "https://vector.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role"
    process.env.VECTOR_PLATFORM_SECRET = "v".repeat(32)
    process.env.AI_GATEWAY_API_KEY = "gateway"
    process.env.VECTOR_CLOUD_AGENT_MODELS = "vercel/anthropic/claude-sonnet-4.5"
    delete process.env.VECTOR_CLOUD_SANDBOX_IMAGE
    delete process.env.CRON_SECRET

    expect(platformConfiguration().cloudAgentsAvailable).toBe(false)

    process.env.VECTOR_CLOUD_SANDBOX_IMAGE = "vcr.vercel.com/vector/cloud-agent:1.59.1"
    process.env.CRON_SECRET = "c".repeat(24)
    expect(platformConfiguration().cloudAgentsAvailable).toBe(true)
  })
})
