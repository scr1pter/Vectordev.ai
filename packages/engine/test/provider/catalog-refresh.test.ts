import { afterEach, expect } from "bun:test"
import { mkdir, rm, stat, utimes, writeFile } from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Flag } from "@vectordevai/core/flag/flag"
import { FreeModels } from "@vectordevai/core/free-models"
import { Global } from "@vectordevai/core/global"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Hash } from "@vectordevai/core/util/hash"
import { Env } from "@/env"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

afterEach(disposeAllInstances)

const mirror = "https://catalog-refresh.test/models"
const cacheFile = path.join(Global.Path.cache, `models-${Hash.fast(ModelCatalog.mirrorURL(mirror)!)}.json`)

const model = (id: string) => ({
  id,
  name: id,
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  tool_call: true,
  limit: { context: 128000, output: 8000 },
  cost: { input: 1, output: 2 },
})
const catalog = (models: string[]) =>
  JSON.stringify({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["CATALOG_REFRESH_TEST_KEY"],
      models: Object.fromEntries(models.map((id) => [id, model(id)])),
    },
  })

// The cache holds one model and is an hour old, so the catalog's startup refresh fetches the mirror.
function harness(served: string[]) {
  return testEffect(
    Layer.unwrap(
      Effect.acquireRelease(
        Effect.promise(async () => {
          const saved = {
            path: Flag.VECTOR_MODELS_PATH,
            disabled: Flag.VECTOR_DISABLE_MODELS_FETCH,
            url: Flag.VECTOR_MODELS_URL,
          }
          Flag.VECTOR_MODELS_PATH = undefined
          Flag.VECTOR_DISABLE_MODELS_FETCH = false
          Flag.VECTOR_MODELS_URL = mirror
          await mkdir(path.dirname(cacheFile), { recursive: true })
          await writeFile(cacheFile, catalog(["claude-cached"]))
          const hourAgo = (Date.now() - 60 * 60 * 1000) / 1000
          await utimes(cacheFile, hourAgo, hourAgo)
          return saved
        }),
        (saved) =>
          Effect.promise(async () => {
            Flag.VECTOR_MODELS_PATH = saved.path
            Flag.VECTOR_DISABLE_MODELS_FETCH = saved.disabled
            Flag.VECTOR_MODELS_URL = saved.url
            await rm(cacheFile, { force: true })
          }),
      ).pipe(
        Effect.as(
          Layer.fresh(
            LayerNode.compile(LayerNode.group([Provider.node, Env.node, ModelCatalog.node]), [
              [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
              [
                httpClient,
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) =>
                    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(catalog(served)))),
                  ),
                ),
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
        ),
      ),
    ),
  )
}

const listed = Effect.gen(function* () {
  const env = yield* Env.Service
  yield* env.set("CATALOG_REFRESH_TEST_KEY", "placeholder-key")
  const provider = yield* Provider.Service
  // The provider state performs the catalog's first load, so it is built from the cached copy.
  const before = yield* provider.list()
  expect(Object.keys(before[ProviderV2.ID.anthropic].models)).toEqual(["claude-cached"])
  return { provider, before }
})

harness(["claude-cached", "claude-mirror"]).instance(
  "a startup catalog refresh that finds a changed mirror reaches the provider list",
  () =>
    Effect.gen(function* () {
      const { provider } = yield* listed
      const modelCatalog = yield* ModelCatalog.Service
      yield* pollWithTimeout(
        modelCatalog.get().pipe(Effect.map((loaded) => (loaded.anthropic?.models["claude-mirror"] ? true : undefined))),
        "the startup refresh never loaded the changed mirror",
        "3 seconds",
      )
      const after = yield* pollWithTimeout(
        provider
          .list()
          .pipe(
            Effect.map((providers) =>
              providers[ProviderV2.ID.anthropic].models["claude-mirror"] ? providers : undefined,
            ),
          ),
        "the provider list kept the cached catalog after the refresh",
        "3 seconds",
      )
      expect(Object.keys(after[ProviderV2.ID.anthropic].models).sort()).toEqual(["claude-cached", "claude-mirror"])
      expect(after[ProviderV2.ID.anthropic].key).toBe("placeholder-key")
    }),
  { trusted: true },
  15_000,
)

harness(["claude-cached"]).instance(
  "a startup catalog refresh that finds the mirror unchanged keeps the provider state",
  () =>
    Effect.gen(function* () {
      const { provider, before } = yield* listed
      // The unchanged refresh only renews the cache file's age.
      yield* pollWithTimeout(
        Effect.promise(() => stat(cacheFile)).pipe(
          Effect.map((info) => (Date.now() - info.mtimeMs < 60_000 ? true : undefined)),
        ),
        "the startup refresh never renewed the cache file",
        "3 seconds",
      )
      yield* Effect.sleep("100 millis")
      expect(yield* provider.list()).toBe(before)
    }),
  { trusted: true },
  15_000,
)
