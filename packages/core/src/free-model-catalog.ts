import { Option, Schema } from "effect"
import type { FreeModelInfo } from "@vectordevai/schema/free-model"

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

/** Shared and personal catalogs use the same price, capability and endpoint policy checks. */
export function freeModelInfo(
  model: typeof FreeModelMetadata.Type,
  endpoints: readonly unknown[],
  selection: { policies: readonly (typeof FreeProviderPolicy.Type)[] } | { zdr: true },
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
    if ("zdr" in selection && endpoint.model_id !== model.id) return []
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
  return {
    id: model.id,
    name: model.name.replace(/\s*(?:\(free\)|:free)\s*$/i, ""),
    contextLength,
    maxOutputTokens,
    providers: eligible.map(({ endpoint, provider }) => ({
      // Preserve the endpoint tag when supplied; a bare slug still selects that provider.
      id: endpoint.tag,
      name: provider?.displayName ?? endpoint.provider_name,
      retention: !provider
        ? "OpenRouter lists this endpoint as zero data retention; no-training routing is required."
        : !provider.dataPolicy.retainsPrompts
          ? "No prompt retention or training according to OpenRouter's provider policy."
          : provider.dataPolicy.retentionDays !== undefined
            ? `Up to ${provider.dataPolicy.retentionDays} days; no training according to OpenRouter's provider policy.`
            : "Prompts retained; duration not specified. No training according to OpenRouter's provider policy.",
    })),
  }
}
