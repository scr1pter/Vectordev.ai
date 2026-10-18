import { Option, Schema } from "effect"

export const FreeModelInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
  providers: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, retention: Schema.String })),
  // Whether the model reasons, from OpenRouter's supported parameters: "optional" means Vector may switch reasoning off
  // for a greeting or a light job; "unsupported" means an endpoint does not take the parameter. Absent when OpenRouter
  // did not say, or on a catalog published before this field existed; Vector then uses the reviewed fallback for that
  // model, if it has one, and otherwise the model keeps its own default.
  reasoning: Schema.optional(Schema.Literals(["optional", "mandatory", "unsupported"])),
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

// Included free models are not zero data retention. Allowlisted providers may keep prompts and outputs under their
// own policies; every request asks OpenRouter to deny data collection, which excludes endpoints it records as
// training on prompts.
export const NO_TRAINING_RETENTION =
  "May keep prompts and outputs under its own policy. Vector requests that they are not used for training."

// A rescue catalog is used only after a client has received explicit server enablement.
// The server still validates its current catalog and free price for every shared request.
// Checked against OpenRouter's public model and endpoint data on 15 October 2026.
export const FREE_MODEL_FALLBACKS: readonly FreeModelInfo[] = [
  {
    id: "cohere/north-mini-code:free",
    name: "Cohere: North Mini Code",
    contextLength: 256000,
    maxOutputTokens: 64000,
    providers: [{ id: "cohere", name: "Cohere", retention: NO_TRAINING_RETENTION }],
    reasoning: "optional",
  },
  {
    // OpenRouter lists this free preview until 31 December 2026.
    id: "dots-studio/dots-3-note-preview:free",
    name: "Dots Studio: Dots3-Note Preview",
    contextLength: 512000,
    maxOutputTokens: 460800,
    providers: [{ id: "atlas-cloud", name: "AtlasCloud", retention: NO_TRAINING_RETENTION }],
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

// Changing agents is not consent to change a free model into a paid one. Retain
// the selection even if discovery no longer offers it; the transport will refuse it.
export function retainFreeModelSelection<T extends { providerID: string; modelID: string }>(model: T | undefined) {
  return model && ["vector", "openrouter"].includes(model.providerID) && model.modelID.toLowerCase().endsWith(":free")
    ? model
    : undefined
}
