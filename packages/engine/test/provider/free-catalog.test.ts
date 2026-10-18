import { afterAll, afterEach, expect } from "bun:test"
import { streamText } from "ai"
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

it.instance("an invited guest is offered no free model that may train, on either route", () =>
  Effect.sync(() => {
    // A guest's prompts run under the owner's acceptance, which the guest never gave, so the guest's lists leave
    // those models out and the default for the guest is a no-training one.
    const providers = Provider.withoutTrainingFreeModels({
      openrouter: Provider.fromFreeModels([laguna, FREE_MODEL_FALLBACKS[0]], "openrouter"),
      vector: Provider.fromFreeModels([laguna, FREE_MODEL_FALLBACKS[1]]),
    })
    expect(Object.keys(providers.openrouter.models)).toEqual([FREE_MODEL_FALLBACKS[0].id])
    expect(Object.keys(providers.vector.models)).toEqual([FREE_MODEL_FALLBACKS[1].id])
    expect(Provider.defaultModelIDs(providers).openrouter).toBe(ModelV2.ID.make(FREE_MODEL_FALLBACKS[0].id))
  }),
)

it.instance(
  "a helper call never moves a conversation onto a free model that may train",
  () =>
    Effect.gen(function* () {
      // The may-train model is listed first, so only the policy check keeps helper calls off it.
      const provider = yield* Provider.Service
      served.catalog = { enabled: true, updatedAt: 1, models: [laguna, ...FREE_MODEL_FALLBACKS] }
      yield* Effect.promise(() => client.catalog(true))
      // Waits for state built from this catalog, not an earlier one with another order.
      yield* pollWithTimeout(
        provider.list().pipe(
          Effect.map((providers) => {
            const vector = providers[ProviderV2.ID.vector]
            return vector && Object.keys(vector.models)[0] === laguna.id ? vector : undefined
          }),
        ),
        "the free catalog was never listed with the may-train model first",
        "3 seconds",
      )
      expect((yield* provider.getSmallModel(ProviderV2.ID.vector))?.id).toBe(
        ModelV2.ID.make(FREE_MODEL_FALLBACKS[0].id),
      )
      // A conversation already on the may-train model, which the user chose and accepted, keeps its helpers there.
      expect((yield* provider.getSmallModel(ProviderV2.ID.vector, ModelV2.ID.make(laguna.id)))?.id).toBe(
        ModelV2.ID.make(laguna.id),
      )
      served.catalog = off
    }),
  { trusted: true },
)

it.instance(
  "a prompt to a may-train free model without the user's acceptance is refused before anything is sent",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      served.catalog = { enabled: true, updatedAt: 1, models: [...FREE_MODEL_FALLBACKS, laguna] }
      yield* Effect.promise(() => client.catalog(true))
      const model = yield* pollWithTimeout(
        provider.getModel(ProviderV2.ID.vector, ModelV2.ID.make(laguna.id)).pipe(Effect.orElseSucceed(() => undefined)),
        "the may-train model was never listed",
        "3 seconds",
      )
      // This client has no consent file, so the engine has no acceptance on record. The request is refused while it
      // is built, before the fetch to vectordev.ai, so this test makes no network request.
      const result = streamText({
        model: yield* provider.getLanguage(model),
        messages: [{ role: "user", content: "hello" }],
        maxRetries: 0,
      })
      const errors: unknown[] = []
      yield* Effect.promise(async () => {
        for await (const part of result.fullStream) if (part.type === "error") errors.push(part.error)
      }).pipe(Effect.orElseSucceed(() => undefined))
      expect(String(errors[0])).toContain("Nothing was sent")
      expect(String(errors[0])).toContain("vector models --accept-training")
      served.catalog = off
    }),
  { trusted: true },
)

// The owner's own OpenRouter provider in the next test: it records every request it receives and answers none.
const reached: string[] = []
const openRouterStandIn = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    reached.push(await request.text())
    return Response.json({ error: { message: "The stand-in answers nothing." } }, { status: 400 })
  },
})
afterAll(() => openRouterStandIn.stop(true))

it.instance(
  "a zero-price OpenRouter model never goes out as a regular model, though it reaches the SDK",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      const send = (model: Provider.Model, text: string) =>
        provider.getLanguage(model).pipe(
          Effect.flatMap((language) =>
            Effect.promise(async () => {
              const result = streamText({ model: language, messages: [{ role: "user", content: text }], maxRetries: 0 })
              const errors: unknown[] = []
              for await (const part of result.fullStream) if (part.type === "error") errors.push(part.error)
              return errors
            }),
          ),
        )
      // The control: a paid model goes to the owner's OpenRouter provider.
      const paid = yield* provider.getModel(ProviderV2.ID.openrouter, ModelV2.ID.make("deepseek/deepseek-chat-v3.1"))
      yield* send(paid, "prompt on a paid model")
      expect(reached.some((text) => text.includes("prompt on a paid model"))).toBe(true)
      // A stealth model at a zero price, with the same destination and key, as a later catalog or configuration could
      // list it, is sent only through the free-model checks, which refuse a model they have not reviewed.
      const errors = yield* send(
        {
          ...paid,
          id: ModelV2.ID.make("openrouter/owl-alpha"),
          api: { ...paid.api, id: "openrouter/owl-alpha" },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        },
        "prompt on a stealth model",
      )
      expect(reached.some((text) => text.includes("prompt on a stealth model"))).toBe(false)
      expect(String(errors[0])).toContain("Connect OpenRouter")
    }),
  {
    trusted: true,
    config: () => ({
      provider: {
        openrouter: { options: { apiKey: "sk-or-synthetic-not-a-key", baseURL: `${openRouterStandIn.url.origin}/v1` } },
      },
    }),
  },
)
