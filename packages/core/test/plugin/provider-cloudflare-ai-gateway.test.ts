import "../../src/plugin/internal"
import { AISDK } from "@vectordevai/core/aisdk"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { PluginV2 } from "@vectordevai/core/plugin"
import { PluginHost } from "@vectordevai/core/plugin/host"
import { CloudflareAIGatewayPlugin } from "@vectordevai/core/plugin/provider/cloudflare-ai-gateway"
import { ProviderV2 } from "@vectordevai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const model = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.make("cloudflare-ai-gateway"), ModelV2.ID.make("openai/fixture")),
  api: { id: ModelV2.ID.make("openai/fixture"), type: "aisdk", package: "ai-gateway-provider" },
})

it.effect("constructs the actual V3 gateway SDK with explicit instance configuration", () =>
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const aisdk = yield* AISDK.Service
    const host = yield* PluginHost.make(plugin)
    yield* CloudflareAIGatewayPlugin.effect(host)
    const result = yield* aisdk.runSDK({
      model,
      package: "ai-gateway-provider",
      options: {
        accountId: "fixture-account",
        gatewayId: "fixture-gateway",
        apiKey: "fixture-token",
        metadata: { product: "Vector" },
        collectLog: false,
        cacheTtl: 30,
      },
    })
    const language = result.sdk.languageModel("openai/fixture")
    expect(language.specificationVersion).toBe("v3")
    expect(language.modelId).toBeDefined()
    expect(typeof language.doGenerate).toBe("function")
    expect(typeof language.doStream).toBe("function")
  }),
)

it.effect("rejects invalid gateway identifiers before any network request", () =>
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const aisdk = yield* AISDK.Service
    const host = yield* PluginHost.make(plugin)
    yield* CloudflareAIGatewayPlugin.effect(host)
    const result = yield* Effect.exit(
      aisdk.runSDK({
        model,
        package: "ai-gateway-provider",
        options: {
          accountId: "fixture-account",
          gatewayId: "../different-account",
          apiKey: "fixture-token",
        },
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

it.effect("leaves unrelated SDK packages to their own handlers", () =>
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const aisdk = yield* AISDK.Service
    const host = yield* PluginHost.make(plugin)
    yield* CloudflareAIGatewayPlugin.effect(host)
    const result = yield* aisdk.runSDK({ model, package: "@ai-sdk/openai", options: {} })
    expect(result.sdk).toBeUndefined()
  }),
)
