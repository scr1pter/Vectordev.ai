import "../../src/plugin/internal"
import { AISDK } from "@vectordevai/core/aisdk"
import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { ModelV2 } from "@vectordevai/core/model"
import { PluginV2 } from "@vectordevai/core/plugin"
import { PluginHost } from "@vectordevai/core/plugin/host"
import { SapAICorePlugin } from "@vectordevai/core/plugin/provider/sap-ai-core"
import { ProviderV2 } from "@vectordevai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const model = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.make("sap-ai-core"), ModelV2.ID.make("gpt-4o")),
  api: { id: ModelV2.ID.make("gpt-4o"), type: "aisdk", package: "@jerome-benoit/sap-ai-provider" },
})

it.effect("creates a real V3 SAP model without exporting credentials into the process environment", () =>
  Effect.gen(function* () {
    const before = process.env.AICORE_SERVICE_KEY
    const plugin = yield* PluginV2.Service
    const aisdk = yield* AISDK.Service
    const host = yield* PluginHost.make(plugin)
    yield* SapAICorePlugin.effect(host)
    const result = yield* aisdk.runSDK({
      model,
      package: "@jerome-benoit/sap-ai-provider",
      options: {
        serviceKey: JSON.stringify({
          clientid: "fixture-client",
          clientsecret: "fixture-secret",
          url: "https://auth.fixture.test",
          serviceurls: { AI_API_URL: "https://api.fixture.test" },
        }),
        deploymentId: "fixture-deployment",
      },
    })
    const language = result.sdk.languageModel("gpt-4o")
    expect(language.specificationVersion).toBe("v3")
    expect(language.modelId).toBe("gpt-4o")
    expect(process.env.AICORE_SERVICE_KEY).toBe(before)
  }),
)

it.effect("rejects a malformed service key without echoing its contents", () =>
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const aisdk = yield* AISDK.Service
    const host = yield* PluginHost.make(plugin)
    yield* SapAICorePlugin.effect(host)
    const result = yield* Effect.exit(
      aisdk.runSDK({
        model,
        package: "@jerome-benoit/sap-ai-provider",
        options: { serviceKey: "fixture-secret-invalid-json" },
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(JSON.stringify(result)).not.toContain("fixture-secret-invalid-json")
  }),
)

it.effect("does not install arbitrary packages advertised under the SAP provider name", () =>
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const aisdk = yield* AISDK.Service
    const host = yield* PluginHost.make(plugin)
    yield* SapAICorePlugin.effect(host)
    const result = yield* aisdk.runSDK({ model, package: "file:///unreviewed-provider.js", options: {} })
    expect(result.sdk).toBeUndefined()
  }),
)

it.effect("rejects service-key endpoint overrides before resolving credentials", () =>
  Effect.promise(async () => {
    const { ProviderSDK } = await import("../../src/provider-sdk")
    const create = await ProviderSDK.load("@jerome-benoit/sap-ai-provider")
    const serviceKey = JSON.stringify({
      clientid: "fixture-client",
      clientsecret: "fixture-secret",
      url: "https://auth.fixture.test",
      serviceurls: { AI_API_URL: "https://api.fixture.test" },
    })
    for (const name of ["url", "baseURL", "socketPath", "auth", "adapter", "transport"]) {
      expect(() => create({ serviceKey, requestConfig: { [name]: "https://foreign.fixture.test" } })).toThrow(
        "cannot be combined",
      )
    }
  }),
)
