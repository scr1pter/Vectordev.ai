export * as ModelCatalog from "./model-catalog"

import { define, inventory } from "./event"
import { Effect, Schema } from "effect"
import { filterProviderCatalog } from "./provider-policy"

const Refreshed = define({
  type: "model-catalog.refreshed",
  schema: {},
})
export const Event = { Refreshed, Definitions: inventory(Refreshed) }

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(false))),
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const BUNDLED_PROVIDER_PACKAGES = [
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/amazon-bedrock/mantle",
  "@ai-sdk/anthropic",
  "@ai-sdk/azure",
  "@ai-sdk/google",
  "@ai-sdk/google-vertex",
  "@ai-sdk/google-vertex/anthropic",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
  "@ai-sdk/xai",
  "@ai-sdk/mistral",
  "@ai-sdk/groq",
  "@ai-sdk/deepinfra",
  "@ai-sdk/cerebras",
  "@ai-sdk/cohere",
  "@ai-sdk/gateway",
  "@ai-sdk/togetherai",
  "@ai-sdk/perplexity",
  "@ai-sdk/vercel",
  "@ai-sdk/alibaba",
  "gitlab-ai-provider",
  "@ai-sdk/github-copilot",
  "venice-ai-sdk-provider",
  "ai-gateway-provider",
  "@jerome-benoit/sap-ai-provider",
  "@aihubmix/ai-sdk-provider",
  "merge-gateway-ai-sdk-provider",
  "watsonx-ai-provider",
  "@qvac/ai-sdk-provider",
] as const

const bundled = new Set<string>(BUNDLED_PROVIDER_PACKAGES)
export function packageAllowed(value: string | undefined) {
  return value === undefined || bundled.has(value)
}

// What the bundled SDKs actually send. @ai-sdk/openai (also behind @ai-sdk/azure and Bedrock's OpenAI "mantle"
// path) accepts four service tiers, honours priority and flex only for model families it knows and silently drops
// them for any other id (gpt-6-astra included), and has no reasoning-mode option; @ai-sdk/amazon-bedrock accepts its
// own four tiers. A catalog mode that needs anything else would fail at send time or quietly run the base model at
// the mode's price, so it is not offered as a model of its own.
const OPENAI_STYLE_PACKAGES = new Set(["@ai-sdk/openai", "@ai-sdk/azure", "@ai-sdk/amazon-bedrock/mantle"])
const OPENAI_SERVICE_TIERS = new Set(["auto", "flex", "priority", "default"])
const BEDROCK_SERVICE_TIERS = new Set(["reserved", "priority", "default", "flex"])

export function modeSupported(
  npm: string | undefined,
  modelID: string,
  body: Readonly<Record<string, unknown>> | undefined,
) {
  if (!body) return true
  const tier = "service_tier" in body ? String(body.service_tier) : undefined
  if (npm === "@ai-sdk/amazon-bedrock") return tier === undefined || BEDROCK_SERVICE_TIERS.has(tier)
  if (!npm || !OPENAI_STYLE_PACKAGES.has(npm)) return true
  if ("reasoning" in body) return false
  if (tier === undefined) return true
  if (tier === "priority") return priorityModel(modelID)
  if (tier === "flex") return flexModel(modelID)
  return OPENAI_SERVICE_TIERS.has(tier)
}

// Mirrors getOpenAILanguageModelCapabilities in the bundled @ai-sdk/openai.
function priorityModel(id: string) {
  if (id.startsWith("gpt-4") || id.startsWith("o3") || id.startsWith("o4-mini")) return true
  return id.startsWith("gpt-5") && !["gpt-5-nano", "gpt-5-chat", "gpt-5.4-nano"].some((prefix) => id.startsWith(prefix))
}

function flexModel(id: string) {
  return id.startsWith("o3") || id.startsWith("o4-mini") || (id.startsWith("gpt-5") && !id.startsWith("gpt-5-chat"))
}

export const Catalog = Schema.Record(Schema.String, Provider)

/**
 * Decodes a provider catalog. Without `omit`, an entry that needs an SDK this build does not bundle rejects the
 * whole catalog, which keeps release preparation strict. With `omit`, such entries are dropped and reported, so a
 * shared mirror written by a later release that bundles more SDKs still refreshes every other provider.
 */
export function decodeCatalog(value: unknown, omit?: (entry: string) => void) {
  const catalog = normalizePackages(Schema.decodeUnknownSync(Catalog, { onExcessProperty: "preserve" })(value))
  for (const [id, provider] of Object.entries(catalog)) {
    if (provider.id !== id) throw new Error(`Catalog provider identity does not match ${id}`)
  }
  // Providers this build filters out anyway never need their SDK checked.
  return Object.fromEntries(
    Object.entries(filterProviderCatalog(catalog)).flatMap(([id, provider]) => {
      if (!packageAllowed(provider.npm)) return unbundled(`Catalog provider ${id}`, provider.npm, omit)
      const models = Object.entries(provider.models).flatMap(([modelID, model]) =>
        packageAllowed(model.provider?.npm)
          ? [[modelID, model] as const]
          : unbundled(`Catalog model ${id}/${modelID}`, model.provider?.npm, omit),
      )
      return [[id, { ...provider, models: Object.fromEntries(models) }] as const]
    }),
  )
}

function unbundled(entry: string, npm: string | undefined, omit: ((entry: string) => void) | undefined) {
  if (!omit) throw new Error(`${entry} requires an unbundled SDK`)
  omit(`${entry} requires the unbundled SDK ${npm}`)
  return []
}

// The upstream catalog used the separate AI SDK V2 package name. Vector bundles
// the reviewed V3 release under its canonical package identity.
export function normalizePackages(catalog: typeof Catalog.Type) {
  const normalize = (npm: string | undefined) =>
    npm === "@jerome-benoit/sap-ai-provider-v2" ? "@jerome-benoit/sap-ai-provider" : npm
  return Object.fromEntries(
    Object.entries(catalog).map(([id, provider]) => {
      const result = {
        ...provider,
        ...(provider.npm ? { npm: normalize(provider.npm) } : {}),
        models: Object.fromEntries(
          Object.entries(provider.models).map(([modelID, model]) => {
            const settings = model.provider ? { ...model.provider } : undefined
            if (id === "qvac" && settings) delete settings.api
            return [
              modelID,
              {
                ...model,
                ...(settings
                  ? { provider: { ...settings, ...(settings.npm ? { npm: normalize(settings.npm) } : {}) } }
                  : {}),
              },
            ]
          }),
        ),
      }
      // QVAC's catalog URL is a placeholder, not a provisioned local runtime.
      // Users select their already-running server explicitly in provider options.
      if (id === "qvac") delete result.api
      return [id, result]
    }),
  )
}
