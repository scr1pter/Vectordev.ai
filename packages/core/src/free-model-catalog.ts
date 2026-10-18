import { Option, Schema } from "effect"
// A relative path, not the package name: vectordev.ai's API functions load this file on Vercel's Node runtime, where the
// package name resolves to Schema's TypeScript source inside node_modules, which Node will not load.
import {
  FREE_ROUTER_ID,
  FREE_ROUTER_RETENTION,
  MAY_TRAIN_RETENTION,
  UNREVIEWED_RETENTION,
  type FreeDataPolicy,
  type FreeModelInfo,
} from "../../schema/src/free-model.js"

// Server code reaches Schema through Core.
export { isFreeModelRef } from "../../schema/src/free-model.js"

export const FreeModelMetadata = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  context_length: Schema.Number,
  pricing: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  supported_parameters: Schema.Array(Schema.String),
  architecture: Schema.optional(
    Schema.Struct({ input_modalities: Schema.Array(Schema.String), output_modalities: Schema.Array(Schema.String) }),
  ),
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
  // OpenRouter's Free Models Router lists no endpoints of its own: it picks a free model at random for each request,
  // so it is as private as the least private free model, and is labelled as one that may train.
  [FREE_ROUTER_ID, { openrouter: { policy: "may-train", retention: FREE_ROUTER_RETENTION } }],
])

// The only free models Vector leaves out are those whose terms bar Vector's use. NVIDIA's free endpoints run under the
// NVIDIA API Trial Terms of Service (19 September 2025): limited trial and evaluation use only, no production use of the
// service or its output (sections 1.2 and 1.4), and no making it or its output available to others (section 4.2).
// Serving them to Vector users is production use that shares the output, so they are never listed.
const BARRED_FREE_AUTHORS = [
  {
    author: /^nvidia\//i,
    provider: "nvidia",
    reason: "NVIDIA's API Trial Terms limit its free endpoints to evaluation and bar production use.",
  },
]

/**
 * The provider slugs of barred free endpoints. A request to the free router asks OpenRouter to skip them, since the
 * router may pick any free model; OpenRouter does not document whether a router honours that, so the router is
 * offered only behind the "May train on your prompts" notice.
 */
export const BARRED_FREE_PROVIDERS = BARRED_FREE_AUTHORS.map((item) => item.provider)

// Free models offered only through the user's own OpenRouter account, never on Vector's shared allowance, because a
// term applies that the shared allowance cannot meet. Clients before 1.99.109 see only the shared catalog, so they
// never receive these either. Serving Gemma there needs the region limit in Google's terms applied, or a finding that
// it does not apply; see docs/vector/owner-actions/free-models-legal.md.
const GEMMA_SHARED =
  "Google's Gemini API terms (28 April 2026) let EEA, Swiss and UK users use it only through Paid Services, and the shared allowance does not check where its users are."
// Xing4.0 was here until 17 October 2026, when the owner decided every free model belongs on the shared allowance
// unless its terms bar it: RedPill's terms, under which Phala serves it, do not address free use, which is not a bar.
const PERSONAL_ONLY_FREE_MODELS: ReadonlyMap<string, string> = new Map([
  ["google/gemma-4-26b-a4b-it:free", GEMMA_SHARED],
  ["google/gemma-4-31b-it:free", GEMMA_SHARED],
])

/** Why a free model is kept off Vector's shared allowance, when it is offered through the user's own account only. */
export function personalOnlyFreeModel(id: string) {
  return PERSONAL_ONLY_FREE_MODELS.get(id)
}

// Router aliases and stacked variants can introduce paid routing or services. The one router allowed is OpenRouter's
// Free Models Router, which picks only free models and is held to a zero max_price like every other free request.
export function isFreeModelID(id: string) {
  return (
    isFreeRouter(id) ||
    (id.trim() === id && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(id) && !/^openrouter\//i.test(id))
  )
}

/** OpenRouter's Free Models Router, exactly as OpenRouter lists it. */
export function isFreeRouter(id: string) {
  return id === FREE_ROUTER_ID
}

/**
 * Whether a model of OpenRouter's regular catalog runs on free endpoints: a `:free` variant, OpenRouter's free router
 * (which picks any free endpoint, barred and unreviewed ones included), a stealth model, or any model listed at a zero
 * price. Sent with the user's own key as a regular OpenRouter model, it would skip every free-model check: the guest
 * rule, the training notice and data_collection. So such a model is offered only as a reviewed free model, or not at
 * all. `price` is undefined for a model with no listed price, such as OpenRouter's Auto Router, which bills the paid
 * model it picks.
 */
export function isOpenRouterFreeModel(
  id: string,
  price: { readonly input: number; readonly output: number } | undefined,
) {
  const lower = id.trim().toLowerCase()
  // A variant stacked after `:free` (`:free:nitro`) or a version after `@` still names the free endpoints.
  return (
    /:free(?:$|[:@])/.test(lower) ||
    /^openrouter\/free(?:$|[:@])/.test(lower) ||
    lower.startsWith("stealth/") ||
    (price?.input === 0 && price.output === 0)
  )
}

/** Whether a request to this URL goes to OpenRouter. */
export function isOpenRouterURL(url: unknown) {
  if (typeof url !== "string" || !URL.canParse(url.trim())) return false
  // A fully qualified name ends in a dot (`openrouter.ai.`, also spelled `openrouter.ai%2E`), and resolves the same.
  const host = new URL(url.trim()).hostname.toLowerCase().replace(/\.+$/, "")
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai")
}

/**
 * Whether a configured model would reach OpenRouter's free endpoints outside the free-model checks. Configuration can
 * name a model one thing and send another (`id` on the legacy engine, `api.id` on V2), and can point a provider of any
 * name at openrouter.ai, so both the catalog name and the ID sent are tested, on the openrouter provider and on any
 * provider whose requests go to OpenRouter. Such a model is removed from the regular lists and, if it reaches the
 * engine anyway, sent only through the free-model route, which refuses a model it has not reviewed.
 */
export function sendsToOpenRouterFree(model: {
  readonly providerID: string
  readonly id: string
  readonly apiID?: string
  /** The model's and its provider's base URLs, and its SDK package: whatever decides where requests go. */
  readonly destinations: readonly unknown[]
  readonly price: { readonly input: number; readonly output: number } | undefined
}) {
  if (!sendsToOpenRouter(model)) return false
  return [model.id, model.apiID].some((id) => typeof id === "string" && isOpenRouterFreeModel(id, model.price))
}

/** Whether a model's requests go to OpenRouter: the openrouter provider, or any provider pointed at openrouter.ai. */
export function sendsToOpenRouter(model: { readonly providerID: string; readonly destinations: readonly unknown[] }) {
  return (
    model.providerID === "openrouter" ||
    model.destinations.some((item) => item === "@openrouter/ai-sdk-provider" || isOpenRouterURL(item))
  )
}

// OpenRouter request fields that let it answer from the endpoints of a model other than the one a request names:
// fallback models (`models`, with `route`) and presets, which can set anything. Provider preferences (`provider`) only
// choose among the endpoints of the model named, and are where a request asks for no training, so they are not here.
const OPENROUTER_MODEL_ROUTING_FIELDS = ["models", "route", "preset"]
// Plugins that leave the answering model alone: web search, PDF parsing and response healing. Any other, such as the
// Auto Router's list of models it may pick, may let OpenRouter answer with another model.
const OPENROUTER_MODEL_KEEPING_PLUGINS = new Set(["web", "file-parser", "response-healing"])

/**
 * The settings in a request to OpenRouter, outside the free-model route, that could let OpenRouter answer from another
 * model's endpoints, including a free one or one whose provider may train on prompts, which the free-model checks
 * never see. `body` is what the request body carries beyond the protocol's own fields, and `modelID` the model it
 * names, which can name a preset (`@preset/…`) or one of OpenRouter's routers (`openrouter/auto`). Such a request is
 * still sent, with its fallbacks, presets and plugins, but asks OpenRouter to deny data collection
 * (denyDataCollection) unless the user accepted the "May train on your prompts" notice in a session no invited guest
 * has worked in.
 */
export function openRouterModelRouting(body: unknown, modelID: unknown) {
  const fields = jsonRecord(body) ?? {}
  const id = typeof modelID === "string" ? modelID.trim().toLowerCase() : ""
  return [
    ...OPENROUTER_MODEL_ROUTING_FIELDS.filter((key) => Object.hasOwn(fields, key)),
    ...(Object.hasOwn(fields, "plugins") && !keepsModel(fields.plugins) ? ["plugins"] : []),
    ...(id.includes("@preset/") ? ["preset"] : []),
    ...(id.startsWith("openrouter/") ? ["model"] : []),
  ]
}

/**
 * The request body asking OpenRouter to route only to endpoints that don't collect prompts for training
 * (`provider.data_collection: "deny"`), whatever the configuration set there, keeping every other provider preference.
 */
export function denyDataCollection(body: unknown): Record<string, unknown> {
  const fields = jsonRecord(body) ?? {}
  return { ...fields, provider: { ...jsonRecord(fields.provider), data_collection: "deny" } }
}

function keepsModel(plugins: unknown) {
  return (
    Array.isArray(plugins) &&
    plugins.every((plugin) => {
      const id = jsonRecord(plugin)?.id
      return typeof id === "string" && OPENROUTER_MODEL_KEEPING_PLUGINS.has(id)
    })
  )
}

function jsonRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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

/**
 * Free, zero-priced, tool-capable, a text chat model and not expired. Models without tools cannot work as coding agents
 * here. A media model can list zero token prices and still charge per clip, so where OpenRouter lists modalities, text
 * must be among the inputs and the only output.
 */
export function eligibleFreeModel(model: typeof FreeModelMetadata.Type, now: number) {
  return (
    isFreeModelID(model.id) &&
    zeroFreeModelPricing(model.pricing) &&
    model.supported_parameters.includes("tools") &&
    (!model.architecture ||
      (model.architecture.input_modalities.includes("text") &&
        model.architecture.output_modalities.length === 1 &&
        model.architecture.output_modalities[0] === "text")) &&
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
  if (isFreeRouter(model.id)) return freeRouterInfo(model)
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
  // Reasoning is switched off for a greeting only on OpenRouter's word that it may be: the model says reasoning is not
  // mandatory, and every endpoint takes the parameter, since the request asks OpenRouter to route only to endpoints
  // that support every parameter it sends. An endpoint without the parameter is stated, so a client never falls back
  // to a reviewed value that would send it.
  const reasoning = !eligible.every((item) => item.endpoint.supported_parameters.includes("reasoning"))
    ? ("unsupported" as const)
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
    ...(eligible.every((item) => item.endpoint.supported_parameters.includes("tool_choice"))
      ? {}
      : { toolChoice: false }),
    ...(reasoning ? { reasoning } : {}),
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

// OpenRouter publishes no output limit for the router. 8,192 tokens is the smallest limit of any tool-capable free
// model on 17 October 2026 (Liquid's LFM2.5-2.6B), so a reply this long fits whichever model the router picks.
const FREE_ROUTER_MAX_OUTPUT_TOKENS = 8192

/** The Free Models Router has no endpoint list; its price and parameters come from its own listing. */
function freeRouterInfo(model: typeof FreeModelMetadata.Type): FreeModelInfo | undefined {
  if (
    !zeroFreeModelPricing(model.pricing) ||
    !model.supported_parameters.includes("tools") ||
    !Number.isSafeInteger(model.context_length) ||
    model.context_length < 1
  )
    return
  return {
    id: model.id,
    name: model.name,
    contextLength: model.context_length,
    maxOutputTokens: Math.min(model.context_length, FREE_ROUTER_MAX_OUTPUT_TOKENS),
    ...(model.supported_parameters.includes("tool_choice") ? {} : { toolChoice: false }),
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        retention: FREE_ROUTER_RETENTION,
        dataPolicy: "may-train",
      },
    ],
  }
}
