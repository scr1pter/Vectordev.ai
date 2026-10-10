import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FreeModels } from "@vectordevai/core/free-models"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Env } from "@/env"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

function fixture() {
  const reads: string[] = []
  const model = (id: string): ModelCatalog.Model => ({
    id,
    name: id,
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    tool_call: true,
    limit: { context: 128000, output: 8000 },
    cost: { input: 1, output: 2, cache_read: 0.1 },
  })
  const models: Record<string, Record<string, ModelCatalog.Model>> = {
    openai: {
      "gpt-5.5": {
        ...model("gpt-5.5"),
        experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
      },
      "retired-exclusive": { ...model("retired-exclusive"), status: "deprecated" },
    },
    anthropic: { "claude-safe": model("claude-safe") },
    azure: { "azure-model": model("azure-model") },
    "google-vertex": { "vertex-model": model("vertex-model") },
  }
  const catalog = Object.fromEntries(
    Object.entries(models).map(([id, value]) => [
      id,
      {
        id,
        name: id,
        npm: id === "openai" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
        env: id === "anthropic" ? ["LAZY_CATALOG_API_KEY"] : [],
        get models() {
          reads.push(id)
          return value
        },
      },
    ]),
  )
  return {
    reads,
    models,
    it: testEffect(
      LayerNode.compile(LayerNode.group([Provider.node, Env.node]), [
        [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
        [
          ModelCatalog.node,
          Layer.succeed(ModelCatalog.Service, { get: () => Effect.succeed(catalog), refresh: () => Effect.void }),
        ],
        [
          FreeModels.node,
          Layer.succeed(FreeModels.Service, {
            catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
            forKey: () => Effect.succeed([]),
          }),
        ],
        [
          FreeModels.credentialsNode,
          Layer.succeed(FreeModels.CredentialsService, { get: () => Effect.succeed(undefined) }),
        ],
      ]),
    ),
  }
}

{
  const loaded = fixture()
  loaded.it.instance(
    "provider metadata scans leave unused models untouched and memoize suggestion normalization",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        expect(Object.keys(yield* provider.list())).toEqual(["lmstudio"])
        expect(loaded.reads).toEqual([])

        const unknown = yield* provider
          .getModel(ProviderV2.ID.make("antropic"), ModelV2.ID.make("unused"))
          .pipe(Effect.flip)
        expect(unknown.suggestions).toContain("anthropic")
        expect(loaded.reads).toEqual([])
        for (const id of ["constructor", "toString", "__proto__"]) {
          const inherited = yield* provider
            .getModel(ProviderV2.ID.make(id), ModelV2.ID.make("unused"))
            .pipe(Effect.flip)
          expect(Provider.ModelNotFoundError.isInstance(inherited)).toBe(true)
        }
        expect(loaded.reads).toEqual([])

        const mode = yield* provider.getModel(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5.5-fast")).pipe(Effect.flip)
        expect(mode.suggestions?.[0]).toBe("gpt-5.5-fast")
        expect(loaded.reads).toEqual(["openai"])
        const retired = yield* provider
          .getModel(ProviderV2.ID.openai, ModelV2.ID.make("retired-exclusive"))
          .pipe(Effect.flip)
        expect(retired.suggestions).not.toContain("retired-exclusive")
        expect(loaded.reads).toEqual(["openai"])
        expect(Object.keys(yield* provider.list())).toEqual(["lmstudio"])
      }),
    { config: { provider: { lmstudio: { models: { local: {} } } } } },
  )
}

{
  const loaded = fixture()
  loaded.it.instance(
    "catalog environment and custom autoload scans preserve connection order without expanding idle providers",
    () =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        yield* env.set("LAZY_CATALOG_API_KEY", "synthetic-key")
        yield* env.set("GOOGLE_VERTEX_PROJECT", "synthetic-project")
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(Object.keys(providers)).toEqual(["anthropic", "google-vertex"])
        expect(providers[ProviderV2.ID.anthropic].key).toBe("synthetic-key")
        expect(providers[ProviderV2.ID.anthropic].source).toBe("env")
        expect(providers[ProviderV2.ID.make("google-vertex")].options.project).toBe("synthetic-project")
        expect(providers[ProviderV2.ID.make("google-vertex")].source).toBe("custom")
        expect(loaded.reads).toEqual(["anthropic", "google-vertex"])
      }),
  )
}

{
  const loaded = fixture()
  loaded.it.instance(
    "config aliases and filters cannot mutate the catalog used for fallback suggestions",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const configured = providers[ProviderV2.ID.anthropic]
        expect(configured.name).toBe("Configured Anthropic")
        expect(Object.keys(configured.models)).toEqual(["renamed"])
        expect(configured.models.renamed.api.id).toBe("claude-safe")
        expect(configured.models.renamed.cost.input).toBe(1)
        configured.models.renamed.cost.input = 999
        expect(loaded.models.anthropic["claude-safe"].cost?.input).toBe(1)
        const missing = yield* provider
          .getModel(ProviderV2.ID.anthropic, ModelV2.ID.make("claude-safe"))
          .pipe(Effect.flip)
        expect(missing.suggestions).toContain("claude-safe")
        expect(loaded.reads).toEqual(["anthropic"])
      }),
    {
      config: {
        provider: {
          anthropic: {
            name: "Configured Anthropic",
            whitelist: ["renamed"],
            models: { renamed: { id: "claude-safe" } },
          },
        },
      },
    },
  )
}
