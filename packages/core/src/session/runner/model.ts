export * as SessionRunnerModel from "./model"

import { makeLocationNode } from "../../effect/app-node"
import { type Model, type ProviderMetadata } from "@vectordevai/llm"
import * as AnthropicMessages from "@vectordevai/llm/protocols/anthropic-messages"
import * as OpenAICompatibleChat from "@vectordevai/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@vectordevai/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@vectordevai/llm/route"
import { Context, Effect, Layer, Schema } from "effect"
import { produce } from "immer"
import { FreeModels } from "../../free-models"
import { freeModelRoute } from "./free-model-route"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionSchema } from "../schema"

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {
  override get message() {
    return `No model is available for session ${this.sessionID}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "SessionRunnerModel.ModelUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
  },
) {
  override get message() {
    return `Model unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class VariantUnavailableError extends Schema.TaggedErrorClass<VariantUnavailableError>()(
  "SessionRunnerModel.VariantUnavailableError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    variant: ModelV2.VariantID,
  },
) {
  override get message() {
    return `Variant unavailable for ${this.providerID}/${this.modelID}: ${this.variant}`
  }
}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: ProviderV2.ID,
    modelID: ModelV2.ID,
    api: Schema.String,
  },
) {
  override get message() {
    return `Unsupported API for ${this.providerID}/${this.modelID}: ${this.api}`
  }
}

export type Error =
  | ModelNotSelectedError
  | ModelUnavailableError
  | VariantUnavailableError
  | UnsupportedApiError
  | Integration.AuthorizationError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Model, Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/v2/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

const pricing = new WeakMap<Model, ModelV2.Info["cost"]>()

export const withPricing = (model: Model, cost: ModelV2.Info["cost"]) => {
  pricing.set(model, cost)
  return model
}

// The smallest long-context tier, at 200K or beyond, past which the model's listed price rises. Some catalogs price
// input in bands from 32K up; those bands do not say where to compact.
export const contextTier = (model: Model) => {
  const sizes = (pricing.get(model) ?? []).flatMap((item) =>
    item.tier?.type === "context" && item.tier.size >= 200_000 ? [item.tier.size] : [],
  )
  return sizes.length ? Math.min(...sizes) : undefined
}

export const calculateCost = (model: Model, tokens: Tokens, metadata?: ProviderMetadata) => {
  const totalNanoAiu = metadata?.copilot?.totalNanoAiu
  if (typeof totalNanoAiu === "number" && Number.isFinite(totalNanoAiu) && totalNanoAiu >= 0)
    // Copilot bills in nano AI units: 1 AI credit is 1e9 nano-AIU and costs $0.01, so USD = nano-AIU / 1e11.
    return totalNanoAiu / 100_000_000_000

  const costs = pricing.get(model)
  if (!costs?.length) return undefined
  const context = tokens.input + tokens.cache.read + tokens.cache.write
  const selected =
    costs
      .filter((item) => item.tier?.type === "context" && context > item.tier.size)
      .sort((left, right) => (right.tier?.size ?? 0) - (left.tier?.size ?? 0))[0] ??
    costs.find((item) => item.tier === undefined)
  if (!selected) return undefined
  const cost =
    (tokens.input * selected.input +
      (tokens.output + tokens.reasoning) * selected.output +
      tokens.cache.read * selected.cache.read +
      tokens.cache.write * selected.cache.write) /
    1_000_000
  if (!Number.isFinite(cost)) return undefined
  return Math.max(0, cost)
}

const apiKey = (model: ModelV2.Info, credential?: Credential.Value) => {
  if (credential?.type === "key") return Auth.value(credential.key)
  if (credential?.type === "oauth") return Auth.value(credential.access)
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  if (typeof value === "string") return Auth.value(value)
}

const withDefaults = (model: ModelV2.Info, route: AnyRoute) => {
  const body = model.request.body
  const httpBody = Object.hasOwn(body, "apiKey")
    ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "apiKey"))
    : body
  return route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: { body: httpBody },
    limits: { context: model.limit.context, output: model.limit.output },
  })
}

const withVariant = (
  model: ModelV2.Info,
  variantID: ModelV2.VariantID | undefined,
): Effect.Effect<ModelV2.Info, VariantUnavailableError> => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant && variantID !== undefined && variantID !== "default")
    return Effect.fail(
      new VariantUnavailableError({
        providerID: model.providerID,
        modelID: model.id,
        variant: variantID,
      }),
    )
  return Effect.succeed(
    variant
      ? produce(model, (draft) => {
          Object.assign(draft.request.headers, variant.headers)
          Object.assign(draft.request.body, variant.body)
        })
      : model,
  )
}

const apiName = (model: ModelV2.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: ModelV2.Info,
  credential?: Credential.Value,
): Effect.Effect<Model, UnsupportedApiError> => {
  const resolved =
    credential?.type !== "key" || credential.metadata === undefined
      ? model
      : produce(model, (draft) => {
          Object.assign(draft.request.body, credential.metadata)
        })
  const key = apiKey(resolved, credential)
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withPricing(
        withDefaults(resolved, OpenAIResponses.route)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: resolved.api.id }),
        resolved.cost,
      ),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withPricing(
        withDefaults(resolved, AnthropicMessages.route)
          .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
          .model({ id: resolved.api.id }),
        resolved.cost,
      ),
    )
  }
  if (resolved.api.type === "aisdk" && resolved.api.package === "@ai-sdk/openai-compatible" && resolved.api.url) {
    return Effect.succeed(
      withPricing(
        withDefaults(resolved, OpenAICompatibleChat.route)
          .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
          .model({ id: resolved.api.id }),
        resolved.cost,
      ),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: resolved.providerID,
      modelID: resolved.id,
      api: apiName(resolved),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: ModelV2.Info, credential?: Credential.Value) =>
  withVariant(model, session.model?.variant).pipe(Effect.flatMap((model) => fromCatalogModel(model, credential)))

export const supported = (model: ModelV2.Info) =>
  requiresFreeRoute(model) ||
  (model.api.type === "aisdk" &&
    (model.api.package === "@ai-sdk/openai" ||
      model.api.package === "@ai-sdk/anthropic" ||
      (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined)))

function requiresFreeRoute(model: ModelV2.Info) {
  return (
    model.providerID === "vector" ||
    !!model.freeModel ||
    (model.providerID === "openrouter" && model.id.toLowerCase().endsWith(":free"))
  )
}

/** Resolves models from the catalog belonging to the current Location runtime. */
export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const freeModels = yield* FreeModels.Service
    const freeCredentials = yield* FreeModels.CredentialsService
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // Location plugins populate and filter the catalog asynchronously during layer startup.
        const defaultModel = session.model
          ? undefined
          : yield* catalog.model
              .default()
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "Catalog.DefaultModelUnavailableError"
                    ? new ModelUnavailableError({ providerID: error.providerID, modelID: error.modelID })
                    : new ModelNotSelectedError({ sessionID: session.id }),
                ),
              )
        const selected = session.model
          ? (yield* catalog.model.available()).find(
              (model) =>
                model.id === session.model?.id &&
                (model.providerID === session.model.providerID ||
                  (session.model.providerID === "vector" &&
                    model.providerID === "openrouter" &&
                    model.freeModel?.source === "openrouter")),
            )
          : defaultModel && supported(defaultModel)
            ? defaultModel
            : (yield* catalog.model.available()).find(supported)
        if (!selected && session.model)
          return yield* new ModelUnavailableError({
            providerID: session.model.providerID,
            modelID: session.model.id,
          })
        if (!selected) return yield* new ModelNotSelectedError({ sessionID: session.id })
        // Configuration can overwrite API metadata or add a free ID after catalog validation.
        // Free intent always crosses the final eligibility and zero-price request guard.
        if (requiresFreeRoute(selected))
          return withPricing(freeModelRoute(selected, freeModels, freeCredentials), [
            { input: 0, output: 0, cache: { read: 0, write: 0 } },
          ])
        const provider = yield* catalog.provider.get(selected.providerID)
        const connection = yield* integrations.connection.active(
          provider?.integrationID ?? Integration.ID.make(selected.providerID),
        )
        return yield* resolve(
          session,
          selected,
          connection ? yield* integrations.connection.resolve(connection) : undefined,
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: locationLayer,
  deps: [Catalog.node, Integration.node, FreeModels.node, FreeModels.credentialsNode],
})
