import { expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { LLM } from "@vectordevai/llm"
import { Catalog } from "@vectordevai/core/catalog"
import { Config } from "@vectordevai/core/config"
import { ConfigProviderPlugin } from "@vectordevai/core/config/plugin/provider"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelV2 } from "@vectordevai/core/model"
import { PluginV2 } from "@vectordevai/core/plugin"
import { PluginHost } from "@vectordevai/core/plugin/host"
import { VectorPlugin } from "@vectordevai/core/plugin/provider/vector"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProviderV2 } from "@vectordevai/core/provider"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const approved = FREE_MODEL_FALLBACKS[0]
const freeModels = FreeModels.Service.of({
  catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
  forKey: () => Effect.succeed([approved]),
})
const credentials = FreeModels.CredentialsService.of({
  get: (provider) => Effect.succeed(provider === "openrouter" ? "synthetic-owned-key" : undefined),
})

for (const scenario of [
  {
    name: "a configured unsupported API cannot replace the verified free default with paid inference",
    id: approved.id,
    package: "@ai-sdk/google",
    explicit: false,
  },
  {
    name: "an unverified free ID added by late configuration cannot use the generic paid transport",
    id: "maker/unverified:free",
    package: "@ai-sdk/openai-compatible",
    explicit: true,
  },
  {
    name: "an uppercase free ID added by late configuration cannot use the generic paid transport",
    id: "maker/unverified:FREE",
    package: "@ai-sdk/openai-compatible",
    explicit: true,
  },
]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)
      yield* VectorPlugin.effect(host).pipe(
        Effect.provideService(FreeModels.Service, freeModels),
        Effect.provideService(FreeModels.CredentialsService, credentials),
      )
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
        Effect.provideService(Config.Service, {
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: Schema.decodeUnknownSync(Config.Info)({
                  model: `openrouter/${scenario.id}`,
                  providers: {
                    openrouter: {
                      models: {
                        [scenario.id]: {
                          api: {
                            id: "maker/paid",
                            type: "aisdk",
                            package: scenario.package,
                            url: "https://paid.invalid/v1",
                          },
                          request: {
                            headers: { Authorization: "injected" },
                            body: { provider: { max_price: { prompt: 10 } } },
                          },
                        },
                        "maker/paid": {
                          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://paid.invalid/v1" },
                          cost: { input: 5, output: 5 },
                        },
                      },
                      cost: { input: 50, output: 50 },
                    },
                  },
                }),
              }),
            ]),
        }),
      )
      expect((yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make(scenario.id)))?.api).toMatchObject({
        package: scenario.package,
      })
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_adversarial_free_config"),
        projectID: ProjectV2.ID.global,
        title: "free selection",
        ...(scenario.explicit
          ? { model: { id: ModelV2.ID.make(scenario.id), providerID: ProviderV2.ID.openrouter } }
          : {}),
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/synthetic-project") },
      })
      const resolved = yield* Effect.gen(function* () {
        const resolver = yield* SessionRunnerModel.Service
        return yield* resolver.resolve(session)
      }).pipe(
        Effect.provide(SessionRunnerModel.locationLayer),
        Effect.provideService(FreeModels.Service, freeModels),
        Effect.provideService(FreeModels.CredentialsService, credentials),
      )
      expect(String(resolved.id)).toBe(scenario.id)
      expect(
        SessionRunnerModel.calculateCost(resolved, {
          input: 100,
          output: 100,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ).toBe(0)
      const prepared = yield* resolved.route
        .prepareTransport(
          { model: resolved.id, messages: [{ role: "user", content: "hello" }] },
          LLM.request({ model: resolved, prompt: "hello" }),
        )
        .pipe(Effect.result)
      if (scenario.explicit) {
        expect(prepared).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "InvalidRequest" } } })
        return
      }
      expect(prepared._tag).toBe("Success")
      if (prepared._tag !== "Success") throw new Error("Expected guarded free request")
      expect(prepared.success.request.url).toBe(FreeModels.OPENROUTER_CHAT_URL)
      expect(prepared.success.request.headers.authorization).toBe("Bearer synthetic-owned-key")
      expect(prepared.success.request.body._tag).toBe("Uint8Array")
      if (prepared.success.request.body._tag !== "Uint8Array") throw new Error("Expected request JSON")
      expect(JSON.parse(new TextDecoder().decode(prepared.success.request.body.body))).toMatchObject({
        model: approved.id,
        provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, zdr: true },
      })
    }),
  )
}
