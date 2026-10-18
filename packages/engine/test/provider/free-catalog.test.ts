import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FREE_MODEL_FALLBACKS, type FreeModelCatalog, type FreeModelInfo } from "@vectordevai/schema/free-model"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const off: FreeModelCatalog = { enabled: false, updatedAt: 0, models: [] }
const laguna: FreeModelInfo = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  // Wider than every no-training model, so only the policy keeps it from being picked by default.
  contextLength: 1_000_000,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" }],
}

// The real catalog client, answering from `served`, so its change notifications are the production ones.
const served = { catalog: off }
const client = FreeModels.createClient({ wait: 60_000, request: async () => Response.json(served.catalog) })
const it = testEffect(
  LayerNode.compile(Provider.node, [
    [FreeModels.node, Layer.succeed(FreeModels.Service, FreeModels.fromClient(client))],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "vector" ? "vct_synthetic" : undefined),
      }),
    ],
  ]),
)

it.instance(
  "provider state built while the free catalog read OFF rebuilds once it turns on",
  () =>
    Effect.gen(function* () {
      // Root cause 5 (17 Oct 2026): state built from a cached OFF answer kept free models hidden all session.
      const provider = yield* Provider.Service
      expect((yield* provider.list())[ProviderV2.ID.vector]).toBeUndefined()
      served.catalog = { enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS, laguna] }
      yield* Effect.promise(() => client.catalog(true))
      const vector = yield* pollWithTimeout(
        provider.list().pipe(Effect.map((providers) => providers[ProviderV2.ID.vector])),
        "provider state was not rebuilt after the free catalog turned on",
        "3 seconds",
      )
      expect(Object.keys(vector.models).sort()).toEqual(
        [...FREE_MODEL_FALLBACKS.map((model) => model.id), laguna.id].sort(),
      )
      // Each model says whether its provider may train on prompts, and the default never picks one that may.
      expect(vector.models[laguna.id].freeModel).toEqual({ source: "shared", dataPolicy: "may-train" })
      expect(vector.models[FREE_MODEL_FALLBACKS[0].id].freeModel).toEqual({
        source: "shared",
        dataPolicy: "no-training",
      })
      expect(Provider.defaultModelIDs({ vector }).vector).not.toBe(laguna.id)
      served.catalog = off
    }),
  { trusted: true },
)

it.instance("with the shared catalog off, the user's own OpenRouter free models keep their free tag", () =>
  Effect.sync(() => {
    // Root cause 3 (17 Oct 2026): every free tag was removed when the shared catalog was off, so after connecting
    // OpenRouter the app showed no free section and selected no model.
    const own = Provider.fromFreeModels([FREE_MODEL_FALLBACKS[0], laguna], "openrouter")
    const shared = Provider.fromFreeModels([FREE_MODEL_FALLBACKS[1]])
    const providers = Provider.applyFreeCatalog({ openrouter: own, vector: shared }, off, true)
    expect(providers.vector).toBeUndefined()
    expect(providers.openrouter.models[FREE_MODEL_FALLBACKS[0].id].freeModel).toEqual({
      source: "openrouter",
      dataPolicy: "no-training",
    })
    expect(providers.openrouter.models[laguna.id].freeModel).toEqual({ source: "openrouter", dataPolicy: "may-train" })
    // The default for the user's own account is a no-training model, even when a may-train one is wider.
    expect(Provider.defaultModelIDs(providers).openrouter).toBe(ModelV2.ID.make(FREE_MODEL_FALLBACKS[0].id))
    // A model that only claims the shared tag loses it.
    const stale = Provider.fromFreeModels([FREE_MODEL_FALLBACKS[1]])
    const listed = Provider.applyFreeCatalog({ other: { ...stale, id: ProviderV2.ID.make("other") } }, off, true)
    expect(listed.other.models[FREE_MODEL_FALLBACKS[1].id].freeModel).toBeUndefined()
    // With the catalog on, its models are listed under Vector unless Vector is disabled.
    const on = { enabled: true, updatedAt: 1, models: [FREE_MODEL_FALLBACKS[1]] }
    expect(Provider.applyFreeCatalog({}, on, true).vector?.models[FREE_MODEL_FALLBACKS[1].id]).toBeDefined()
    expect(Provider.applyFreeCatalog({}, on, false).vector).toBeUndefined()
  }),
)
