import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const owned = [FREE_MODEL_FALLBACKS[0], { ...FREE_MODEL_FALLBACKS[0], id: "acme/wide:free", contextLength: 512000 }]

const layer = (models = owned) =>
  LayerNode.compile(Provider.node, [
    [
      FreeModels.node,
      Layer.succeed(FreeModels.Service, {
        catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
        forKey: () => Effect.succeed(models),
      }),
    ],
    [
      FreeModels.credentialsNode,
      Layer.succeed(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "openrouter" ? "synthetic-key" : undefined),
      }),
    ],
  ])
const it = testEffect(layer())
const empty = testEffect(layer([]))

const config = {
  small_model: "openrouter/acme/paid",
  provider: {
    openrouter: {
      npm: "@ai-sdk/openai-compatible",
      options: { apiKey: "synthetic-key" },
      models: {
        "acme/paid": { cost: { input: 1, output: 1 }, limit: { context: 128000, output: 8000 } },
        "acme/unreviewed:free": { cost: { input: 0, output: 0 } },
        "acme/unreviewed:FREE": { id: "acme/paid", cost: { input: 0, output: 0 } },
      },
    },
  },
}

empty.instance(
  "empty free discovery never selects a paid model implicitly",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect(yield* provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make("acme/paid"))).toBeDefined()
      expect(Provider.defaultModelIDs(yield* provider.list()).openrouter).toBeUndefined()
      expect(yield* provider.defaultModel().pipe(Effect.result)).toMatchObject({ _tag: "Failure" })
    }),
  { config },
)

empty.instance(
  "an empty OpenRouter whitelist cannot reveal a paid implicit fallback",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const listed = yield* provider.list()
      expect(listed[ProviderV2.ID.openrouter].models).toEqual({})
      expect(listed[ProviderV2.ID.anthropic]).toBeDefined()
      expect(yield* provider.defaultModel().pipe(Effect.result)).toMatchObject({ _tag: "Failure" })
    }),
  {
    config: {
      provider: {
        openrouter: { ...config.provider.openrouter, whitelist: ["acme/missing:free"] },
        anthropic: { options: { apiKey: "synthetic-key" } },
      },
    },
  },
)

it.instance(
  "personal free models work with shared models off and all implicit defaults stay free",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const providers = yield* provider.list()
      const expected = { providerID: ProviderV2.ID.openrouter, modelID: ModelV2.ID.make(owned[1].id) }
      expect(providers[ProviderV2.ID.vector]).toBeUndefined()
      expect(providers[ProviderV2.ID.openrouter].models["acme/unreviewed:free"]).toBeUndefined()
      expect(providers[ProviderV2.ID.openrouter].models["acme/unreviewed:FREE"]).toBeUndefined()
      expect(providers[ProviderV2.ID.openrouter].models["acme/paid"]).toBeDefined()
      expect(yield* provider.defaultModel()).toEqual(expected)
      expect(Provider.defaultModelIDs(providers).openrouter).toBe(expected.modelID)
      expect(yield* provider.savedModel({ providerID: "vector", modelID: expected.modelID })).toEqual(expected)
      expect(yield* provider.getSmallModel(ProviderV2.ID.openrouter, ModelV2.ID.make(expected.modelID))).toMatchObject({
        id: expected.modelID,
        freeModel: { source: "openrouter" },
      })
    }),
  { config },
)

it.instance(
  "an explicit paid model remains available",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      expect(yield* provider.defaultModel()).toEqual({
        providerID: ProviderV2.ID.openrouter,
        modelID: ModelV2.ID.make("acme/paid"),
      })
    }),
  { config: { ...config, model: "openrouter/acme/paid" } },
)

for (const id of ["acme/missing:free", "acme/unreviewed:FREE"])
  it.instance(
    `an unavailable configured ${id} is retained so execution fails without a paid fallback`,
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        expect(yield* provider.defaultModel()).toEqual({
          providerID: ProviderV2.ID.openrouter,
          modelID: ModelV2.ID.make(id),
        })
        expect(
          yield* provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make(id)).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" })
      }),
    { config: { ...config, model: `openrouter/${id}` } },
  )
