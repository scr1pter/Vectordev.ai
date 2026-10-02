import { expect } from "bun:test"
import { Effect } from "effect"
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
