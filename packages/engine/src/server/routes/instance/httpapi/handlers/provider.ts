import { FreeModels } from "@vectordevai/core/free-models"
import { ProviderAuth } from "@/provider/auth"
import { Config } from "@/config/config"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { Provider } from "@/provider/provider"

import { mapValues } from "remeda"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProviderAuthApiError } from "../groups/provider"
import { ProviderV2 } from "@vectordevai/core/provider"
import { RequestPrincipal } from "@vectordevai/protocol/middleware/authorization"

function mapProviderAuthError<A, R>(self: Effect.Effect<A, ProviderAuth.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => {
      if (error instanceof ProviderAuth.OauthMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCodeMissing) {
        return new ProviderAuthApiError({ name: error._tag, data: { providerID: error.providerID } })
      }
      if (error instanceof ProviderAuth.OauthCallbackFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: {} })
      }
      if (error instanceof ProviderAuth.ValidationFailed) {
        return new ProviderAuthApiError({ name: error._tag, data: { field: error.field, message: error.message } })
      }
      return new ProviderAuthApiError({ name: "BadRequest", data: {} })
    }),
  )
}

export const providerHandlers = HttpApiBuilder.group(InstanceHttpApi, "provider", (handlers) =>
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const provider = yield* Provider.Service
    const svc = yield* ProviderAuth.Service
    const freeModels = yield* FreeModels.Service

    const list = Effect.fn("ProviderHttpApi.list")(function* () {
      const config = yield* cfg.get()
      const all = yield* ModelCatalog.Service.use((s) => s.get())
      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
      const filtered: Record<string, (typeof all)[string]> = {}
      for (const [key, value] of Object.entries(all)) {
        if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) filtered[key] = value
      }
      const connected = yield* provider.list()
      const providers = Object.assign(
        mapValues(filtered, (item) => Provider.fromModelCatalogProvider(item)),
        mapValues(connected, Provider.toPublicInfo),
      )
      Provider.applyFreeCatalog(
        providers,
        yield* freeModels.catalog(),
        !disabled.has("vector") && (!enabled || enabled.has("vector")),
      )
      if ((yield* RequestPrincipal).kind !== "owner") Provider.withoutTrainingFreeModels(providers)
      const selectable = new Set(Object.keys(connected).filter((id) => !!providers[id]))
      // The app hides Fast for these, offers them for Vector Local's roles and labels a research cap in steps for the
      // ones with no per-token price, so it never works out where a model's requests go a second time.
      const hosted = yield* Effect.forEach(
        Object.values(connected).flatMap((item) => Object.values(item.models)),
        (model) =>
          provider.line(model).pipe(
            Effect.map((line) =>
              line?.hosted
                ? [
                    {
                      providerID: model.providerID,
                      modelID: model.id,
                      origin: line.origin,
                      local: line.local && model.cost.input === 0 && model.cost.output === 0,
                    },
                  ]
                : [],
            ),
          ),
      )
      return {
        all: Object.values(providers).map(Provider.toClientInfo),
        default: Provider.defaultModelIDs(providers),
        connected: [...selectable],
        unavailable: yield* provider.unavailable(),
        hosted: hosted.flat(),
      }
    })

    // A guest has no acceptance of its own: the owner's covers only the owner's prompts.
    const freeModelConsent = Effect.fn("ProviderHttpApi.freeModelConsent")(function* () {
      if ((yield* RequestPrincipal).kind !== "owner") return { training: false }
      return { training: yield* freeModels.trainingConsent() }
    })

    // Guests cannot reach this: every non-GET /provider/ route is owner-only.
    const setFreeModelConsent = Effect.fn("ProviderHttpApi.setFreeModelConsent")(function* (ctx: {
      payload: { training: boolean }
    }) {
      return { training: yield* freeModels.setTrainingConsent(ctx.payload.training) }
    })

    const auth = Effect.fn("ProviderHttpApi.auth")(function* () {
      return yield* svc.methods()
    })

    const authorize = Effect.fn("ProviderHttpApi.authorize")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.AuthorizeInput
    }) {
      return yield* mapProviderAuthError(
        svc.authorize({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          inputs: ctx.payload.inputs,
        }),
      )
    })

    const authorizeRaw = Effect.fn("ProviderHttpApi.authorizeRaw")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderAuth.AuthorizeInput))(body).pipe(
        Effect.mapError(() => new ProviderAuthApiError({ name: "BadRequest", data: {} })),
      )
      // Match legacy route behavior: when authorize() resolves without a
      // result (e.g. no further redirect), serialize as JSON `null` instead
      // of an empty body so clients can `.json()` parse the response.
      const result = yield* authorize({ params: ctx.params, payload })
      return HttpServerResponse.jsonUnsafe(result ?? null)
    })

    const callback = Effect.fn("ProviderHttpApi.callback")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: ProviderAuth.CallbackInput
    }) {
      yield* mapProviderAuthError(
        svc.callback({
          providerID: ctx.params.providerID,
          method: ctx.payload.method,
          code: ctx.payload.code,
        }),
      )
      return true
    })

    return handlers
      .handle("list", list)
      .handle("freeModelConsent", freeModelConsent)
      .handle("setFreeModelConsent", setFreeModelConsent)
      .handle("auth", auth)
      .handleRaw("authorize", authorizeRaw)
      .handle("callback", callback)
  }),
)
