import { Option, Schema } from "effect"

export const FreeModelInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
  providers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, retention: Schema.String })),
})
export type FreeModelInfo = typeof FreeModelInfo.Type

export const FreeModelCatalog = Schema.Struct({
  enabled: Schema.Boolean,
  updatedAt: Schema.Number,
  models: Schema.Array(FreeModelInfo),
})
export type FreeModelCatalog = typeof FreeModelCatalog.Type

export const FreeModelLimitReason = Schema.Literals([
  "user_daily",
  "user_minute",
  "shared_daily",
  "upstream",
  "balance",
])
export type FreeModelLimitReason = typeof FreeModelLimitReason.Type

export const FreeModelLimit = Schema.Struct({
  type: Schema.Literal("free_models_limit"),
  code: Schema.Literal("VECTOR_FREE_MODELS_LIMIT"),
  reason: FreeModelLimitReason,
  resetAt: Schema.Finite,
  message: Schema.String,
}).annotate({ identifier: "FreeModelLimit" })
export type FreeModelLimit = typeof FreeModelLimit.Type

export class FreeModelsLimitError extends Schema.TaggedErrorClass<FreeModelsLimitError>()("FreeModelsLimitError", {
  reason: FreeModelLimitReason,
  resetAt: Schema.Finite,
  message: Schema.String,
}) {}

export function parseFreeModelLimit(value: unknown): FreeModelLimit | undefined {
  const parsed =
    typeof value === "string"
      ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(value))
      : value
  const candidate = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : parsed
  return Option.getOrUndefined(Schema.decodeUnknownOption(FreeModelLimit)(candidate))
}

// A rescue catalog is used only after a client has received explicit server enablement.
// The server still validates its current catalog and free price for every shared request.
export const FREE_MODEL_FALLBACKS: readonly FreeModelInfo[] = [
  {
    id: "cohere/north-mini-code:free",
    name: "Cohere: North Mini Code",
    contextLength: 256000,
    maxOutputTokens: 64000,
    providers: [
      {
        id: "cohere",
        name: "Cohere",
        retention: "Up to 30 days; no training according to OpenRouter's provider policy.",
      },
    ],
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Poolside: Laguna S 2.1",
    contextLength: 262144,
    maxOutputTokens: 32768,
    providers: [
      {
        id: "poolside",
        name: "Poolside",
        retention: "Prompts retained; duration not specified. No training according to OpenRouter's provider policy.",
      },
    ],
  },
  {
    id: "poolside/laguna-xs-2.1:free",
    name: "Poolside: Laguna XS 2.1",
    contextLength: 262144,
    maxOutputTokens: 32768,
    providers: [
      {
        id: "poolside",
        name: "Poolside",
        retention: "Prompts retained; duration not specified. No training according to OpenRouter's provider policy.",
      },
    ],
  },
  {
    id: "qwen/qwen3.8-27b:free",
    name: "Qwen: Qwen3.8 27B",
    contextLength: 262144,
    maxOutputTokens: 235929,
    providers: [
      {
        id: "modelrun",
        name: "ModelRun",
        retention: "No prompt retention or training according to OpenRouter's provider policy.",
      },
    ],
  },
  {
    id: "dots-studio/dots-3-note-preview:free",
    name: "Dots Studio: Dots3-Note Preview",
    contextLength: 512000,
    maxOutputTokens: 460800,
    providers: [
      {
        id: "atlas-cloud",
        name: "AtlasCloud",
        retention: "Prompts retained; duration not specified. No training according to OpenRouter's provider policy.",
      },
    ],
  },
  {
    id: "inclusionai/ling-3.0-flash-sante:free",
    name: "inclusionAI: Ling 3.0 Flash Sante",
    contextLength: 262144,
    maxOutputTokens: 32768,
    providers: [
      {
        id: "novita",
        name: "NovitaAI",
        retention: "No prompt retention or training according to OpenRouter's provider policy.",
      },
    ],
  },
  {
    id: "inclusionai/ling-3.0-flash-fin:free",
    name: "inclusionAI: Ling 3.0 Flash Fin",
    contextLength: 262144,
    maxOutputTokens: 32768,
    providers: [
      {
        id: "novita",
        name: "NovitaAI",
        retention: "No prompt retention or training according to OpenRouter's provider policy.",
      },
    ],
  },
]

// Price metadata and the explicit free variant must agree; an unpriced model is not free.
export function isFreeModel(model: { providerID: string; id: string; cost?: { input: number; output: number } }) {
  return (
    (model.providerID === "vector" || model.providerID === "openrouter") &&
    model.id.toLowerCase().endsWith(":free") &&
    model.cost?.input === 0 &&
    model.cost.output === 0
  )
}
