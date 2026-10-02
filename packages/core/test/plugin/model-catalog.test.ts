import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@vectordevai/core/catalog"
import { Integration } from "@vectordevai/core/integration"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Flag } from "@vectordevai/core/flag/flag"
import { Location } from "@vectordevai/core/location"
import { ModelV2 } from "@vectordevai/core/model"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ModelCatalogPlugin } from "@vectordevai/core/plugin/model-catalog"
import { ProviderV2 } from "@vectordevai/core/provider"
import { AbsolutePath } from "@vectordevai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, EventV2.node]), [
  [Location.node, locationLayer],
])
const it = testEffect(layer)

describe("ModelCatalogPlugin", () => {
  it.effect("projects catalog modes as separate models instead of variants", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const models = ModelCatalog.Service.of({
        get: () =>
          Effect.succeed({
            lmstudio: {
              id: "lmstudio",
              name: "Acme",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              api: "https://api.lmstudio.test/v1",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  family: "gpt",
                  release_date: "2026-01-01",
                  attachment: false,
                  reasoning: true,
                  temperature: true,
                  tool_call: true,
                  cost: {
                    input: 2.5,
                    output: 15,
                    tiers: [
                      {
                        tier: { type: "context", size: 272_000 },
                        input: 3,
                        output: 18,
                        cache_read: 0.25,
                      },
                    ],
                    context_over_200k: { input: 5, output: 22.5, cache_read: 0.5 },
                  },
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                  experimental: {
                    modes: {
                      fast: {
                        cost: { input: 5, output: 30, cache_read: 0.5 },
                        provider: {
                          headers: { "x-mode": "fast" },
                          body: { service_tier: "priority" },
                        },
                      },
                    },
                  },
                },
              },
            },
          } satisfies Record<string, ModelCatalog.Provider>),
        refresh: () => Effect.void,
      })

      yield* ModelCatalogPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelCatalog.Service, models))

      const providerID = ProviderV2.ID.make("lmstudio")
      const base = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4"))
      const fast = yield* catalog.model.get(providerID, ModelV2.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.request.body).toEqual({})
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        providerID: "lmstudio",
        name: "GPT-5.4 Fast",
        api: { id: "gpt-5.4" },
        request: {
          headers: { "x-mode": "fast" },
          body: { service_tier: "priority" },
        },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        { input: 5, output: 30, cache: { read: 0.5, write: 0 } },
        // context_over_200k is models.dev's 200K stand-in for the exact tier above, so it adds no tier of its own.
        {
          tier: { type: "context", size: 272_000 },
          input: 3,
          output: 18,
          cache: { read: 0.25, write: 0 },
        },
      ])
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.VECTOR_MODELS_PATH,
          disabled: Flag.VECTOR_DISABLE_MODELS_FETCH,
        }
        Flag.VECTOR_MODELS_PATH = path.join(import.meta.dir, "fixtures", "model-catalog.json")
        Flag.VECTOR_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          yield* ModelCatalogPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("lmstudio"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(AppNodeBuilder.build(ModelCatalog.node))),
      (previous) =>
        Effect.sync(() => {
          Flag.VECTOR_MODELS_PATH = previous.path
          Flag.VECTOR_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})

it.effect("unreviewed catalog IDs cannot register providers or integrations", () =>
  Effect.gen(function* () {
    const integrations = yield* Integration.Service
    const catalog = yield* Catalog.Service
    const models = ModelCatalog.Service.of({
      get: () =>
        Effect.succeed({
          "unreviewed-catalog": {
            id: "unreviewed-catalog",
            name: "Unreviewed",
            env: ["UNREVIEWED_CATALOG_KEY"],
            npm: "@ai-sdk/openai-compatible",
            models: {},
          },
        }),
      refresh: () => Effect.void,
    })
    yield* ModelCatalogPlugin.effect(
      host({ catalog: catalogHost(catalog), integration: integrationHost(integrations) }),
    ).pipe(Effect.provideService(ModelCatalog.Service, models))
    expect(yield* catalog.provider.all()).toEqual([])
    expect(yield* integrations.list()).toEqual([])
  }),
)
