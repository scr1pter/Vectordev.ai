import { Option, Schema } from "effect"
// A relative path, not the package name: vectordev.ai's API functions load this file on Vercel's Node runtime, where the
// package name resolves to Schema's TypeScript source inside node_modules, which Node will not load.
import {
  MAY_TRAIN_RETENTION,
  UNREVIEWED_RETENTION,
  type FreeDataPolicy,
  type FreeModelInfo,
} from "../../schema/src/free-model.js"

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

/** The date Vector last reviewed every free OpenRouter endpoint's data policy and terms. */
export const FREE_MODEL_POLICY_REVIEWED = "2026-10-17"

// OpenRouter's public API has no training flag, and its provider-level records do not describe free endpoints: they
// record Poolside as not training while its free Laguna endpoints say free use may train. The reliable record is the
// per-endpoint `data_policy` on each model's page at https://openrouter.ai/<model id>, checked against the terms each
// endpoint links. This map is that review, by model and the provider slug (the endpoint tag before any "/") that may
// serve it. A free endpoint missing here is "unreviewed": it is disclosed as one that may train, offered only through
// the user's own OpenRouter account, and still asks OpenRouter to deny data collection. Evidence, dated per pair, is in
// docs/vector/owner-actions/free-models-legal.md.
export const REVIEWED_FREE_ENDPOINTS: ReadonlyMap<
  string,
  Readonly<Record<string, { policy: Exclude<FreeDataPolicy, "unreviewed">; retention: string }>>
> = new Map<string, Record<string, { policy: Exclude<FreeDataPolicy, "unreviewed">; retention: string }>>([
  [
    "xingchen-agi/xing4.0-29b-a4b:free",
    { phala: { policy: "no-training", retention: "No prompt retention or training on OpenRouter's endpoint record." } },
  ],
  [
    "cohere/north-mini-code:free",
    { cohere: { policy: "no-training", retention: "Kept up to 30 days; not used for training." } },
  ],
  [
    "dots-studio/dots-3-note-preview:free",
    {
      "atlas-cloud": {
        policy: "no-training",
        retention: "Kept for a period AtlasCloud does not publish; not used for training.",
      },
    },
  ],
  [
    "google/gemma-4-26b-a4b-it:free",
    { "google-ai-studio": { policy: "no-training", retention: "Kept up to 55 days; not used for training." } },
  ],
  [
    "google/gemma-4-31b-it:free",
    { "google-ai-studio": { policy: "no-training", retention: "Kept up to 55 days; not used for training." } },
  ],
  // Poolside's free Laguna endpoints end on 31 October 2026.
  ["poolside/laguna-s-2.1:free", { poolside: { policy: "may-train", retention: MAY_TRAIN_RETENTION } }],
  ["poolside/laguna-xs-2.1:free", { poolside: { policy: "may-train", retention: MAY_TRAIN_RETENTION } }],
  // Liquid advises against this small model for agentic coding.
  ["liquid/lfm-2.5-2.6b:free", { liquid: { policy: "may-train", retention: MAY_TRAIN_RETENTION } }],
  // Thinking Machines' free research tier is for agentic harnesses and adults, and takes no tool_choice.
  ["thinkingmachines/inkling:free", { thinkingmachines: { policy: "may-train", retention: MAY_TRAIN_RETENTION } }],
  [
    "thinkingmachines/inkling-small:free",
    { thinkingmachines: { policy: "may-train", retention: MAY_TRAIN_RETENTION } },
  ],
])

// The only free models Vector leaves out are those whose terms bar Vector's use. NVIDIA's free endpoints run under the
// NVIDIA API Trial Terms of Service (19 September 2025): limited trial and evaluation use only, no production use of the
// service or its output (sections 1.2 and 1.4), and no making it or its output available to others (section 4.2).
// Serving them to Vector users is production use that shares the output, so they are never listed.
const BARRED_FREE_AUTHORS = [
  {
    author: /^nvidia\//i,
    reason: "NVIDIA's API Trial Terms limit its free endpoints to evaluation and bar production use.",
  },
]

// Free models offered only through the user's own OpenRouter account, never on Vector's shared allowance, because a
// term applies that the shared allowance cannot meet. Clients before 1.99.109 see only the shared catalog, so they
// never receive these either. Whether to serve Gemma on the shared allowance is an open owner decision; see
// docs/vector/owner-actions/free-models-legal.md.
const GEMMA_SHARED =
  "Google's Gemini API terms (28 April 2026) let EEA, Swiss and UK users use it only through Paid Services, and the shared allowance does not check where its users are."
const PERSONAL_ONLY_FREE_MODELS: ReadonlyMap<string, string> = new Map([
  ["google/gemma-4-26b-a4b-it:free", GEMMA_SHARED],
  ["google/gemma-4-31b-it:free", GEMMA_SHARED],
])

/** Why a free model is kept off Vector's shared allowance, when it is offered through the user's own account only. */
export function personalOnlyFreeModel(id: string) {
  return PERSONAL_ONLY_FREE_MODELS.get(id)
}

// Router aliases and stacked variants can introduce paid routing or services.
export function isFreeModelID(id: string) {
  return id.trim() === id && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(id) && !/^openrouter\//i.test(id)
}

/** Why a free model is never offered, when its terms bar Vector's use. */
export function barredFreeModel(id: string) {
  return BARRED_FREE_AUTHORS.find((item) => item.author.test(id))?.reason
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

/** Free, zero-priced, tool-capable and not expired. Models without tools cannot work as coding agents here. */
export function eligibleFreeModel(model: typeof FreeModelMetadata.Type, now: number) {
  return (
    isFreeModelID(model.id) &&
    zeroFreeModelPricing(model.pricing) &&
    model.supported_parameters.includes("tools") &&
    (!model.expiration_date || Date.parse(model.expiration_date) > now)
  )
}

/** Shared and personal catalogs offer every eligible free model except barred ones, with a 7-day expiry buffer. */
export function offeredFreeModel(model: typeof FreeModelMetadata.Type, now: number) {
  return !barredFreeModel(model.id) && eligibleFreeModel(model, now + 7 * 86400000)
}

export function reviewedFreeModel(id: string) {
  return REVIEWED_FREE_ENDPOINTS.has(id)
}

/** The reviewed policy of one endpoint, by its tag. Anything not reviewed is "unreviewed", never no-training. */
export function freeEndpointPolicy(modelID: string, tag: string): FreeDataPolicy {
  return REVIEWED_FREE_ENDPOINTS.get(modelID)?.[tag.split("/")[0] ?? ""]?.policy ?? "unreviewed"
}

/**
 * A model's policy is its least private endpoint's, since OpenRouter may route to any of them. A provider without a
 * stated policy (a catalog from before 1.99.109) falls back to the reviewed record.
 */
export function freeModelDataPolicy(model: Pick<FreeModelInfo, "id" | "providers">): FreeDataPolicy {
  const policies = model.providers.map((provider) => provider.dataPolicy ?? freeEndpointPolicy(model.id, provider.id))
  if (!policies.length || policies.includes("unreviewed")) return "unreviewed"
  if (policies.includes("may-train")) return "may-train"
  return "no-training"
}

/** Shared and personal catalogs use the same price, capability and endpoint policy checks. */
export function freeModelInfo(
  model: typeof FreeModelMetadata.Type,
  endpoints: readonly unknown[],
  selection: { reviewedOnly: boolean },
): FreeModelInfo | undefined {
  const eligible = endpoints.flatMap((item) => {
    const parsed = Schema.decodeUnknownOption(FreeEndpointMetadata)(item)
    if (Option.isNone(parsed)) return []
    const endpoint = parsed.value
    const dataPolicy = freeEndpointPolicy(model.id, endpoint.tag)
    if (
      endpoint.model_id !== model.id ||
      (selection.reviewedOnly && dataPolicy === "unreviewed") ||
      !endpoint.tag.trim() ||
      endpoint.status !== 0 ||
      !zeroFreeModelPricing(endpoint.pricing) ||
      !endpoint.supported_parameters.includes("tools")
    )
      return []
    return [{ endpoint, dataPolicy }]
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
    ...(eligible.every((item) => item.endpoint.supported_parameters.includes("tool_choice"))
      ? {}
      : { toolChoice: false }),
    providers: eligible.map(({ endpoint, dataPolicy }) => ({
      // Preserve the endpoint tag when supplied; a bare slug still selects that provider.
      id: endpoint.tag,
      name: endpoint.provider_name,
      retention:
        REVIEWED_FREE_ENDPOINTS.get(model.id)?.[endpoint.tag.split("/")[0] ?? ""]?.retention ?? UNREVIEWED_RETENTION,
      dataPolicy,
    })),
  }
}
