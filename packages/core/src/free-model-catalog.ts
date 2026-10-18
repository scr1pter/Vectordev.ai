import { Option, Schema } from "effect"
// A relative path, not the package name: vectordev.ai's API functions load this file on Vercel's Node runtime, where the
// package name resolves to Schema's TypeScript source inside node_modules, which Node will not load.
import { NO_TRAINING_RETENTION, type FreeModelInfo } from "../../schema/src/free-model.js"

export const FreeProviderPolicy = Schema.Struct({
  name: Schema.String,
  displayName: Schema.String,
  slug: Schema.String,
  dataPolicy: Schema.Struct({
    training: Schema.Boolean,
    trainingOpenRouter: Schema.Boolean,
    retainsPrompts: Schema.Boolean,
    retentionDays: Schema.optional(Schema.Number),
    canPublish: Schema.Boolean,
  }),
})

export const FreeModelMetadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  context_length: Schema.Number,
  pricing: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  supported_parameters: Schema.Array(Schema.String),
  expiration_date: Schema.optional(Schema.NullOr(Schema.String)),
  top_provider: Schema.optional(Schema.Struct({ max_completion_tokens: Schema.NullOr(Schema.Number) })),
  reasoning: Schema.optional(
    Schema.NullOr(Schema.Struct({ mandatory: Schema.optional(Schema.NullOr(Schema.Boolean)) })),
  ),
})

export const FreeEndpointMetadata = Schema.Struct({
  model_id: Schema.optional(Schema.String),
  provider_name: Schema.String,
  tag: Schema.String,
  context_length: Schema.Number,
  max_completion_tokens: Schema.NullOr(Schema.Number),
  pricing: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  supported_parameters: Schema.Array(Schema.String),
  status: Schema.Number,
})

// OpenRouter's public endpoint data has no training flag, and provider-level policy records do not describe free
// endpoints reliably: they recorded Poolside as not training while its free Laguna pages say free use may train.
// So the no-training selection allowlists each model with the provider slugs that may serve it, and a new free
// model is never offered until it is added here. Every request also asks OpenRouter to deny data collection.
// The dated evidence and the owner confirmations each pair needs are in docs/vector/owner-actions/openrouter.md.
export const NO_TRAINING_ENDPOINTS = new Map([
  ["cohere/north-mini-code:free", ["cohere"]],
  ["dots-studio/dots-3-note-preview:free", ["atlas-cloud"]],
])

// Free variants from these authors log or may train on prompts, or their free tier is unreviewed.
const EXCLUDED_AUTHORS = /^(?:nvidia|stealth|thinkingmachines|liquid|google)\//i

// Router aliases and stacked variants can introduce paid routing or services.
export function isFreeModelID(id: string) {
  return id.trim() === id && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(id) && !/^openrouter\//i.test(id)
}

export function zeroFreeModelPricing(pricing: Readonly<Record<string, string | number>>) {
  return (
    Number(pricing.prompt) === 0 &&
    Number(pricing.completion) === 0 &&
    Object.entries(pricing)
      .filter(([key]) => key !== "discount")
      .every(([, value]) => String(value).trim() !== "" && Number(value) === 0)
  )
}

export function eligibleFreeModel(model: typeof FreeModelMetadata.Type, now: number) {
  return (
    isFreeModelID(model.id) &&
    zeroFreeModelPricing(model.pricing) &&
    model.supported_parameters.includes("tools") &&
    model.supported_parameters.includes("tool_choice") &&
    (!model.expiration_date || Date.parse(model.expiration_date) > now)
  )
}

/** Included and personal no-training catalogs share the allowlist, author exclusions and a 7-day expiry buffer. */
export function includedFreeModel(model: typeof FreeModelMetadata.Type, now: number) {
  return (
    NO_TRAINING_ENDPOINTS.has(model.id) && !excludedFreeModel(model.id) && eligibleFreeModel(model, now + 7 * 86400000)
  )
}

export function excludedFreeModel(id: string) {
  return EXCLUDED_AUTHORS.test(id)
}

export function noTrainingEndpoint(modelID: string, tag: string) {
  return !!NO_TRAINING_ENDPOINTS.get(modelID)?.includes(tag.split("/")[0] ?? "")
}

/** Shared and personal catalogs use the same price, capability and endpoint policy checks. */
export function freeModelInfo(
  model: typeof FreeModelMetadata.Type,
  endpoints: readonly unknown[],
  selection: { policies: readonly (typeof FreeProviderPolicy.Type)[] } | { zdr: true } | { noTraining: true },
): FreeModelInfo | undefined {
  const eligible = endpoints.flatMap((item) => {
    const parsed = Schema.decodeUnknownOption(FreeEndpointMetadata)(item)
    if (Option.isNone(parsed)) return []
    const endpoint = parsed.value
    const provider =
      "policies" in selection
        ? selection.policies.find(
            (item) => item.name === endpoint.provider_name && endpoint.tag.split("/")[0] === item.slug,
          )
        : undefined
    if (("zdr" in selection || "noTraining" in selection) && endpoint.model_id !== model.id) return []
    if ("noTraining" in selection && !noTrainingEndpoint(model.id, endpoint.tag)) return []
    if (
      ("policies" in selection &&
        (!provider ||
          !provider.slug.trim() ||
          provider.dataPolicy.training ||
          provider.dataPolicy.trainingOpenRouter ||
          provider.dataPolicy.canPublish)) ||
      !endpoint.tag.trim() ||
      endpoint.status !== 0 ||
      !zeroFreeModelPricing(endpoint.pricing) ||
      !endpoint.supported_parameters.includes("tools") ||
      !endpoint.supported_parameters.includes("tool_choice")
    )
      return []
    return [{ endpoint, provider }]
  })
  if (!eligible.length) return
  const contextLength = Math.min(model.context_length, ...eligible.map((item) => item.endpoint.context_length))
  const maxOutputTokens = Math.min(
    model.top_provider?.max_completion_tokens ?? contextLength,
    ...eligible.map((item) => item.endpoint.max_completion_tokens ?? contextLength),
  )
  if (
    !Number.isSafeInteger(contextLength) ||
    contextLength < 1 ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 1
  )
    return
  // Reasoning is switched off for a greeting only on OpenRouter's word that it may be: the model says reasoning is not
  // mandatory, and every endpoint takes the parameter, since the request asks OpenRouter to route only to endpoints
  // that support every parameter it sends.
  const reasoning = !eligible.every((item) => item.endpoint.supported_parameters.includes("reasoning"))
    ? undefined
    : model.reasoning?.mandatory === true
      ? ("mandatory" as const)
      : model.reasoning?.mandatory === false
        ? ("optional" as const)
        : undefined
  return {
    id: model.id,
    name: model.name.replace(/\s*(?:\(free\)|:free)\s*$/i, ""),
    contextLength,
    maxOutputTokens,
    ...(reasoning ? { reasoning } : {}),
    providers: eligible.map(({ endpoint, provider }) => ({
      // Preserve the endpoint tag when supplied; a bare slug still selects that provider.
      id: endpoint.tag,
      name: provider?.displayName ?? endpoint.provider_name,
      retention:
        "noTraining" in selection
          ? NO_TRAINING_RETENTION
          : !provider
            ? "OpenRouter lists this endpoint as zero data retention; no-training routing is required."
            : !provider.dataPolicy.retainsPrompts
              ? "No prompt retention or training according to OpenRouter's provider policy."
              : provider.dataPolicy.retentionDays !== undefined
                ? `Up to ${provider.dataPolicy.retentionDays} days; no training according to OpenRouter's provider policy.`
                : "Prompts retained; duration not specified. No training according to OpenRouter's provider policy.",
    })),
  }
}
