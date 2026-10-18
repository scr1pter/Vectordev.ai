import { expect } from "bun:test"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { Catalog } from "@vectordevai/core/catalog"
import { Config } from "@vectordevai/core/config"
import { ConfigProviderPlugin } from "@vectordevai/core/config/plugin/provider"
import { FreeModels } from "@vectordevai/core/free-models"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelV2 } from "@vectordevai/core/model"
import { PluginV2 } from "@vectordevai/core/plugin"
import { PluginHost } from "@vectordevai/core/plugin/host"
import { FreeModelGuardPlugin, VectorPlugin } from "@vectordevai/core/plugin/provider/vector"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProviderV2 } from "@vectordevai/core/provider"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionRunnerModel } from "@vectordevai/core/session/runner/model"
import { FREE_MODEL_UNLISTED } from "@vectordevai/core/free-model-choice"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
// No invited guest has worked in these sessions.
const noGuests = FreeModelGuests.Service.of({ mark: () => Effect.void, marked: () => Effect.succeed(false) })
const approved = FREE_MODEL_FALLBACKS[0]
const freeModels = FreeModels.Service.of({
  catalog: () => Effect.succeed({ enabled: false, updatedAt: 0, models: [] }),
  forKey: () => Effect.succeed([approved]),
  trainingConsent: () => Effect.succeed(false),
  setTrainingConsent: (accepted) => Effect.succeed(accepted),
  changes: Stream.empty,
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
  // OpenRouter's free router picks any free endpoint, unreviewed and barred ones included.
  {
    name: "OpenRouter's free router added by late configuration cannot use the generic paid transport",
    id: "openrouter/free",
    package: "@ai-sdk/openai-compatible",
    explicit: true,
  },
  // A stealth model runs on free endpoints that log prompts, though its ID has no free suffix.
  {
    name: "a zero-price model added by late configuration cannot use the generic paid transport",
    id: "openrouter/owl-alpha",
    package: "@ai-sdk/openai-compatible",
    explicit: true,
    cost: { input: 0, output: 0 },
  },
] as { name: string; id: string; package: string; explicit: boolean; cost?: { input: number; output: number } }[]) {
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
                          ...(scenario.cost ? { cost: scenario.cost } : {}),
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
        Effect.provideService(FreeModelGuests.Service, noGuests),
        Effect.provideService(
          ModelPlans.Service,
          ModelPlans.Service.of({
            catalog: () => Effect.succeed({ enabled: false, models: [] }),
            request: () => Promise.reject(new Error("Codium is off in this test")),
          }),
        ),
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
      const sent = JSON.parse(new TextDecoder().decode(prepared.success.request.body.body))
      expect(sent).toMatchObject({
        model: approved.id,
        provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, data_collection: "deny" },
      })
      expect(sent.provider).not.toHaveProperty("zdr")
    }),
  )
}

const laguna = {
  id: "poolside/laguna-s-2.1:free",
  name: "Poolside: Laguna S 2.1",
  contextLength: 262144,
  maxOutputTokens: 32768,
  providers: [{ id: "poolside/fp4", name: "Poolside", retention: "", dataPolicy: "may-train" as const }],
}

for (const shared of [[laguna], [laguna, approved]])
  it.effect(
    `a session whose default cannot run is never given a may-train free model automatically (${shared.length} listed)`,
    () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const host = yield* PluginHost.make(yield* PluginV2.Service)
        yield* VectorPlugin.effect(host).pipe(
          Effect.provideService(
            FreeModels.Service,
            FreeModels.Service.of({
              ...freeModels,
              catalog: () => Effect.succeed({ enabled: true, updatedAt: 0, models: shared }),
            }),
          ),
          Effect.provideService(FreeModels.CredentialsService, {
            get: (provider) => Effect.succeed(provider === "vector" ? "vct_signed-in.token" : undefined),
          }),
        )
        // The configured default uses an API the runner cannot call, so the runner chooses for the session.
        yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
          Effect.provideService(Config.Service, {
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: Schema.decodeUnknownSync(Config.Info)({
                    model: "acme/unsupported",
                    providers: {
                      acme: {
                        options: { apiKey: "synthetic-key" },
                        models: {
                          unsupported: {
                            api: { type: "aisdk", package: "@ai-sdk/google", url: "https://acme.invalid" },
                          },
                        },
                      },
                    },
                  }),
                }),
              ]),
          }),
        )
        const session = { id: SessionV2.ID.make("ses_automatic_free_choice"), model: undefined }
        const chosen = yield* SessionRunnerModel.select(catalog, session).pipe(Effect.result)
        if (shared.length === 1) {
          expect(chosen).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "SessionRunnerModel.ModelNotSelectedError" },
          })
          return
        }
        expect(chosen).toMatchObject({ _tag: "Success", success: { id: approved.id } })
      }),
  )

// The verifier's medium of 17 October 2026: the runner judged a model by its catalog name only, so a free model
// configured under a name that looks paid went out on the generic route, with no guest rule, notice or data_collection.
for (const scenario of [
  {
    name: "a free OpenRouter model configured under a paid-looking name never goes out on the generic route",
    providerID: "openrouter",
    modelID: "alias-laguna",
    api: { id: "poolside/laguna-s-2.1:free", url: "https://openrouter.ai/api/v1" },
  },
  {
    name: "OpenRouter's free router configured under another name never goes out on the generic route",
    providerID: "openrouter",
    modelID: "alias-router",
    api: { id: "openrouter/free", url: "https://openrouter.ai/api/v1" },
  },
  {
    name: "a free model under a provider of another name pointed at openrouter.ai never goes out on the generic route",
    providerID: "or-proxy",
    modelID: "poolside/laguna-xs-2.1:free",
    api: { id: "poolside/laguna-xs-2.1:free", url: "https://openrouter.ai/api/v1" },
  },
  {
    name: "a renamed free model under a provider of another name pointed at openrouter.ai never goes out either",
    providerID: "or-proxy",
    modelID: "renamed",
    api: { id: "thinkingmachines/inkling:free", url: "https://eu.openrouter.ai/api/v1" },
  },
]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const host = yield* PluginHost.make(yield* PluginV2.Service)
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
                  providers: {
                    [scenario.providerID]: {
                      models: {
                        [scenario.modelID]: {
                          api: { ...scenario.api, type: "aisdk", package: "@ai-sdk/openai-compatible" },
                          request: { body: { apiKey: "sk-or-synthetic-not-a-key" } },
                        },
                      },
                    },
                  },
                }),
              }),
            ]),
        }),
      )
      const providerID = ProviderV2.ID.make(scenario.providerID)
      const modelID = ModelV2.ID.make(scenario.modelID)
      expect(yield* catalog.model.get(providerID, modelID)).toBeDefined()
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_free_alias"),
        projectID: ProjectV2.ID.global,
        title: "free alias",
        model: { id: modelID, providerID },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        location: { directory: AbsolutePath.make("/synthetic-project") },
      })
      // An invited guest has worked in this session, and the owner has accepted the notice: the generic route would
      // send the guest's text to a may-train model under the owner's acceptance.
      const resolved = yield* Effect.gen(function* () {
        const resolver = yield* SessionRunnerModel.Service
        return yield* resolver.resolve(session)
      }).pipe(
        Effect.provide(SessionRunnerModel.locationLayer),
        Effect.provideService(
          FreeModelGuests.Service,
          FreeModelGuests.Service.of({ mark: () => Effect.void, marked: () => Effect.succeed(true) }),
        ),
        Effect.provideService(
          ModelPlans.Service,
          ModelPlans.Service.of({
            catalog: () => Effect.succeed({ enabled: false, models: [] }),
            request: () => Promise.reject(new Error("Codium is off in this test")),
          }),
        ),
        Effect.provideService(FreeModels.Service, { ...freeModels, trainingConsent: () => Effect.succeed(true) }),
        Effect.provideService(FreeModels.CredentialsService, credentials),
      )
      const prepared = yield* resolved.route
        .prepareTransport(
          { model: resolved.id, messages: [{ role: "user", content: "guest secret" }] },
          LLM.request({ model: resolved, prompt: "guest secret" }),
        )
        .pipe(Effect.result)
      // A name that is not a free model ID is refused as unlisted; a free ID the account does not list is refused too.
      expect(prepared).toMatchObject({
        _tag: "Failure",
        failure: {
          reason: {
            _tag: "InvalidRequest",
            ...(scenario.modelID.includes(":free") ? {} : { message: FREE_MODEL_UNLISTED }),
          },
        },
      })
      // Configuration loads after the provider plugins; the guard after it keeps the model out of the lists too.
      yield* FreeModelGuardPlugin.effect(host)
      expect(yield* catalog.model.get(providerID, modelID)).toBeUndefined()
      // Vector's own free models stay.
      expect(yield* catalog.model.get(ProviderV2.ID.openrouter, ModelV2.ID.make(approved.id))).toBeDefined()
    }),
  )
}

// The verifier's medium of 18 October 2026: a model named like a paid one went out on the generic route with fallbacks
// onto OpenRouter's free endpoints in its request body, with the owner's key and a guest's text. The integrator's
// decision on the fix (18 October 2026): regular OpenRouter models keep their fallbacks, presets and plugins, web search
// included, but where those could reach another model's endpoints the request asks OpenRouter to deny data collection,
// unless the user accepted the "May train on your prompts" notice in a session no invited guest has worked in.
for (const scenario of [
  {
    name: "a paid OpenRouter model keeps its free fallback, which may not train without the notice accepted",
    providerID: "openrouter",
    modelID: "acme/paid-model",
    model: {
      api: { id: "acme/paid-model", url: "https://openrouter.ai/api/v1" },
      request: {
        body: { models: ["poolside/laguna-s-2.1:free"], provider: { data_collection: "allow", sort: "price" } },
      },
    },
    consent: false,
    guest: false,
    sent: { models: ["poolside/laguna-s-2.1:free"], provider: { data_collection: "deny", sort: "price" } },
  },
  {
    name: "a variant's fallback onto the free router may not train in a session a guest has worked in, accepted or not",
    providerID: "or-proxy",
    modelID: "acme/paid-model",
    variant: "cheap",
    model: {
      api: { id: "acme/paid-model", url: "https://eu.openrouter.ai/api/v1" },
      variants: [{ id: "cheap", body: { models: ["openrouter/free"], route: "fallback" } }],
    },
    consent: true,
    guest: true,
    sent: { models: ["openrouter/free"], route: "fallback", provider: { data_collection: "deny" } },
  },
  {
    name: "fallbacks set on the provider follow its configuration once the owner accepted, with no guest",
    providerID: "openrouter",
    modelID: "acme/paid-model",
    providerBody: { models: ["thinkingmachines/inkling:free"], provider: { data_collection: "allow" } },
    model: { api: { id: "acme/paid-model", url: "https://openrouter.ai/api/v1" } },
    consent: true,
    guest: false,
    sent: { models: ["thinkingmachines/inkling:free"], provider: { data_collection: "allow" } },
  },
  {
    name: "an OpenRouter preset named in the model ID is sent, asking that its models not train",
    providerID: "or-proxy",
    modelID: "acme/paid-preset",
    model: { api: { id: "acme/paid@preset/free-coding", url: "https://openrouter.ai/api/v1" } },
    consent: false,
    guest: false,
    sent: { model: "acme/paid@preset/free-coding", provider: { data_collection: "deny" } },
  },
  {
    name: "a plugin that can pick another model is sent, asking that the model it picks not train",
    providerID: "openrouter",
    modelID: "acme/paid-model",
    model: {
      api: { id: "acme/paid-model", url: "https://openrouter.ai/api/v1" },
      request: { body: { plugins: [{ id: "web" }, { id: "auto-router", allowed_models: ["*"] }] } },
    },
    consent: false,
    guest: false,
    sent: {
      plugins: [{ id: "web" }, { id: "auto-router", allowed_models: ["*"] }],
      provider: { data_collection: "deny" },
    },
  },
  {
    name: "the web search plugin goes out unchanged, even for a guest, since it never changes the model",
    providerID: "openrouter",
    modelID: "acme/paid-model",
    model: {
      api: { id: "acme/paid-model", url: "https://openrouter.ai/api/v1" },
      request: { body: { plugins: [{ id: "web", max_results: 3 }] } },
    },
    consent: false,
    guest: true,
    sent: { plugins: [{ id: "web", max_results: 3 }] },
    unchanged: ["provider"],
  },
  {
    name: "a fallback a plugin adds to the request as it is sent is seen too",
    providerID: "openrouter",
    modelID: "acme/paid-model",
    model: { api: { id: "acme/paid-model", url: "https://openrouter.ai/api/v1" } },
    request: { models: ["liquid/lfm-2.5-2.6b:free"] },
    consent: false,
    guest: false,
    sent: { models: ["liquid/lfm-2.5-2.6b:free"], provider: { data_collection: "deny" } },
  },
  {
    name: "provider preferences alone still send a paid OpenRouter model as configured",
    providerID: "or-proxy",
    modelID: "acme/paid-model",
    model: {
      api: { id: "acme/paid-model", url: "https://openrouter.ai/api/v1" },
      request: { body: { provider: { data_collection: "allow", zdr: true } } },
    },
    consent: false,
    guest: true,
    sent: { provider: { data_collection: "allow", zdr: true } },
  },
  {
    name: "a free model under a provider at a trailing-dot OpenRouter host takes the free route, which refuses it",
    providerID: "proxy",
    modelID: "renamed",
    model: { api: { id: "poolside/laguna-s-2.1:free", url: "https://openrouter.ai./api/v1" } },
    consent: true,
    guest: false,
    unlisted: true,
  },
] as {
  name: string
  providerID: string
  modelID: string
  variant?: string
  providerBody?: Record<string, unknown>
  model: Record<string, unknown> & { api: Record<string, unknown> }
  request?: Record<string, unknown>
  consent: boolean
  guest: boolean
  sent?: Record<string, unknown>
  unchanged?: string[]
  unlisted?: boolean
}[]) {
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* PluginV2.Service)
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
                  providers: {
                    [scenario.providerID]: {
                      request: { body: { apiKey: "sk-or-synthetic-not-a-key", ...scenario.providerBody } },
                      models: {
                        [scenario.modelID]: {
                          ...scenario.model,
                          api: { ...scenario.model.api, type: "aisdk", package: "@ai-sdk/openai-compatible" },
                        },
                      },
                    },
                  },
                }),
              }),
            ]),
        }),
      )
      const session = SessionV2.Info.make({
        id: SessionV2.ID.make("ses_openrouter_routing"),
        projectID: ProjectV2.ID.global,
        title: "openrouter routing",
        model: {
          id: ModelV2.ID.make(scenario.modelID),
          providerID: ProviderV2.ID.make(scenario.providerID),
          ...(scenario.variant ? { variant: ModelV2.VariantID.make(scenario.variant) } : {}),
        },
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
        Effect.provideService(
          FreeModelGuests.Service,
          FreeModelGuests.Service.of({ mark: () => Effect.void, marked: () => Effect.succeed(scenario.guest) }),
        ),
        Effect.provideService(
          ModelPlans.Service,
          ModelPlans.Service.of({
            catalog: () => Effect.succeed({ enabled: false, models: [] }),
            request: () => Promise.reject(new Error("Codium is off in this test")),
          }),
        ),
        Effect.provideService(FreeModels.Service, {
          ...freeModels,
          trainingConsent: () => Effect.succeed(scenario.consent),
        }),
        Effect.provideService(FreeModels.CredentialsService, credentials),
      )
      // Every request the route makes is recorded here, and none reaches a network.
      const outbound: { url: string; body: Record<string, unknown> }[] = []
      const streamed = yield* LLMClient.stream(
        LLM.request({
          model: resolved,
          prompt: "guest secret",
          ...(scenario.request ? { http: { body: scenario.request } } : {}),
        }),
      ).pipe(
        Stream.runDrain,
        Effect.result,
        Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
        Effect.provideService(
          FetchHttpClient.Fetch,
          Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              outbound.push({ url: String(input), body: await new Response(init?.body).json() })
              return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
            },
            { preconnect: fetch.preconnect },
          ),
        ),
      )
      if (scenario.unlisted) {
        expect(streamed).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "InvalidRequest", message: FREE_MODEL_UNLISTED } },
        })
        expect(outbound).toEqual([])
        // The guard after configuration keeps it out of the lists too.
        const catalog = yield* Catalog.Service
        yield* FreeModelGuardPlugin.effect(host)
        expect(
          yield* catalog.model.get(ProviderV2.ID.make(scenario.providerID), ModelV2.ID.make(scenario.modelID)),
        ).toBeUndefined()
        return
      }
      // One request, on the generic route to OpenRouter, with the user's configuration kept.
      expect(outbound).toHaveLength(1)
      expect(outbound[0].url).toStartWith(String(scenario.model.api.url))
      expect(outbound[0].body).toMatchObject({ model: scenario.model.api.id, ...scenario.sent })
      for (const key of scenario.unchanged ?? []) expect(outbound[0].body[key]).toBeUndefined()
      expect(JSON.stringify(outbound[0].body)).toContain("guest secret")
    }),
  )
}

it.effect("a session on a shared model stays shared while the user's own OpenRouter account lists the same model", () =>
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const host = yield* PluginHost.make(yield* PluginV2.Service)
    yield* VectorPlugin.effect(host).pipe(
      Effect.provideService(
        FreeModels.Service,
        FreeModels.Service.of({
          ...freeModels,
          catalog: () => Effect.succeed({ enabled: true, updatedAt: 0, models: [approved] }),
        }),
      ),
      Effect.provideService(FreeModels.CredentialsService, {
        get: (provider) => Effect.succeed(provider === "openrouter" ? "synthetic-owned-key" : "vct_signed-in.token"),
      }),
    )
    for (const providerID of [ProviderV2.ID.vector, ProviderV2.ID.openrouter]) {
      const session = {
        id: SessionV2.ID.make(`ses_both_copies_${providerID}`),
        model: { providerID, id: ModelV2.ID.make(approved.id) },
      }
      // Each copy runs where it was chosen: the shared one on Vector's allowance, the own one on the user's account.
      expect(yield* SessionRunnerModel.select(catalog, session)).toMatchObject({
        providerID,
        id: approved.id,
        freeModel: { source: providerID === ProviderV2.ID.vector ? "shared" : "openrouter" },
      })
    }
  }),
)
