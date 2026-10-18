import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { Catalog } from "@vectordevai/core/catalog"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelV2 } from "@vectordevai/core/model"
import { PluginV2 } from "@vectordevai/core/plugin"
import { PluginHost } from "@vectordevai/core/plugin/host"
import { VectorPlugin } from "@vectordevai/core/plugin/provider/vector"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

it.effect("owned free models stay guarded and available while the shared allowance is off", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const plugin = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugin)
    const paid = ModelV2.ID.make("acme/paid")
    const stale = ModelV2.ID.make("acme/unreviewed:free")
    yield* catalog.transform((draft) => {
      draft.provider.update(ProviderV2.ID.openrouter, () => {})
      draft.model.update(ProviderV2.ID.openrouter, paid, () => {})
      draft.model.update(ProviderV2.ID.openrouter, stale, () => {})
    })
    yield* VectorPlugin.effect(host).pipe(
      Effect.provideService(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([FREE_MODEL_FALLBACKS[0]]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
      Effect.provideService(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "openrouter" ? "synthetic-key" : undefined),
      }),
    )
    expect(yield* catalog.provider.get(ProviderV2.ID.vector)).toBeUndefined()
    expect(yield* catalog.model.get(ProviderV2.ID.openrouter, stale)).toBeUndefined()
    expect(yield* catalog.model.get(ProviderV2.ID.openrouter, paid)).toBeDefined()
    expect(yield* catalog.model.default()).toMatchObject({
      id: FREE_MODEL_FALLBACKS[0].id,
      providerID: "openrouter",
      freeModel: { source: "openrouter" },
    })
  }),
)

it.effect("owned free models say their data policy, and the default never picks one that may train", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const plugin = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugin)
    const laguna = {
      id: "poolside/laguna-s-2.1:free",
      name: "Poolside: Laguna S 2.1",
      // Wider than the no-training model, so only the policy keeps it from being the default.
      contextLength: 1_000_000,
      maxOutputTokens: 32768,
      providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
    }
    yield* VectorPlugin.effect(host).pipe(
      Effect.provideService(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([laguna, FREE_MODEL_FALLBACKS[0]]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
      Effect.provideService(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "openrouter" ? "synthetic-key" : undefined),
      }),
    )
    expect(yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make(laguna.id))).toMatchObject({
      freeModel: { source: "openrouter", dataPolicy: "may-train" },
    })
    expect(yield* catalog.model.default()).toMatchObject({
      id: FREE_MODEL_FALLBACKS[0].id,
      freeModel: { source: "openrouter", dataPolicy: "no-training" },
    })
  }),
)

it.effect("OpenRouter's free router, stealth models and zero-price models never stay regular OpenRouter models", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const plugin = yield* PluginV2.Service
    const host = yield* PluginHost.make(plugin)
    const zero = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
    // Sent as regular OpenRouter models with the user's own key, these would reach free endpoints without the guest
    // rule, the training notice or data_collection. A paid model and an unpriced paid router stay.
    const free = ["openrouter/free", "openrouter/owl-alpha", "stealth/space-bunny-alpha", "inclusionai/ling-3.1-flash"]
    const kept = ["acme/paid", "openrouter/auto"]
    yield* catalog.transform((draft) => {
      draft.provider.update(ProviderV2.ID.openrouter, () => {})
      for (const [id, cost] of [
        ["openrouter/free", zero],
        ["openrouter/owl-alpha", zero],
        ["stealth/space-bunny-alpha", []],
        ["inclusionai/ling-3.1-flash", zero],
        ["acme/paid", [{ input: 1, output: 2, cache: { read: 0, write: 0 } }]],
        ["openrouter/auto", []],
      ] as const)
        draft.model.update(ProviderV2.ID.openrouter, ModelV2.ID.make(id), (model) => {
          model.cost = [...cost]
        })
    })
    yield* VectorPlugin.effect(host).pipe(
      Effect.provideService(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed([]),
        trainingConsent: () => Effect.succeed(false),
        setTrainingConsent: (accepted) => Effect.succeed(accepted),
        changes: Stream.empty,
      }),
      Effect.provideService(FreeModels.CredentialsService, { get: () => Effect.succeed(undefined) }),
    )
    for (const id of free)
      expect(yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make(id))).toBeUndefined()
    for (const id of kept) expect(yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make(id))).toBeDefined()
  }),
)
