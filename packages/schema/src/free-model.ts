import { Option, Schema } from "effect"
import { optional } from "./schema.js"

/**
 * What a free endpoint's provider may do with request content, from Vector's reviewed record in
 * packages/core/src/free-model-catalog.ts. An endpoint the record does not know is "may-train", the worst case. Engines
 * from before 23 October 2026 called such an endpoint "unreviewed" on a user's own OpenRouter account; Vector no longer
 * produces that value and reads it as "may-train", never as no-training.
 */
export const FreeDataPolicy = Schema.Literals(["no-training", "may-train", "unreviewed"])
export type FreeDataPolicy = typeof FreeDataPolicy.Type

export const FreeModelInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
  /** False when a serving endpoint does not accept `tool_choice`; requests then leave out an automatic choice. */
  toolChoice: Schema.optional(Schema.Boolean),
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      retention: Schema.String,
      // Catalogs from vectordev.ai before 1.99.109 carry no policy; readers then fall back to the reviewed record.
      dataPolicy: Schema.optional(FreeDataPolicy),
    }),
  ),
  // When OpenRouter ends the model's free endpoints (milliseconds since the epoch), from its `expiration_date`. A catalog
  // stops listing the model then, and a request for it is refused with FREE_MODEL_EXPIRED; clients that predate the
  // field ignore it.
  expiresAt: Schema.Finite.pipe(optional),
  // Whether the model reasons, from OpenRouter's supported parameters: "optional" means Vector may switch reasoning off
  // for a greeting; "unsupported" means an endpoint does not take the parameter. Absent when OpenRouter
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

// Vector does not request zero data retention for free models. No-training providers may keep prompts and outputs
// under their own policies; every request to them asks OpenRouter to deny data collection, which excludes endpoints
// it records as training on prompts.
export const NO_TRAINING_RETENTION =
  "May keep prompts and outputs under its own policy. Vector requests that they are not used for training."
export const MAY_TRAIN_RETENTION =
  "This provider may log your prompts, code and outputs and use them to train its models."
export const FREE_ROUTER_RETENTION =
  "OpenRouter sends each request to a free model it picks at random, and that model's provider may log your prompts, code and outputs and use them to train its models."
export const UNREVIEWED_RETENTION =
  "Vector has not reviewed this provider's data policy yet, so it is treated as one that may train on your prompts."

// A rescue catalog is used only after a client has received explicit server enablement.
// The server still validates its current catalog and free price for every shared request.
// Checked against OpenRouter's public model and endpoint data on 15 October 2026; data policy reviewed 17 October 2026.
export const FREE_MODEL_FALLBACKS: readonly FreeModelInfo[] = [
  {
    id: "cohere/north-mini-code:free",
    name: "Cohere: North Mini Code",
    contextLength: 256000,
    maxOutputTokens: 64000,
    providers: [{ id: "cohere", name: "Cohere", retention: NO_TRAINING_RETENTION, dataPolicy: "no-training" }],
    reasoning: "optional",
  },
  {
    // OpenRouter lists this free preview until 31 December 2026.
    id: "dots-studio/dots-3-note-preview:free",
    name: "Dots Studio: Dots3-Note Preview",
    contextLength: 512000,
    maxOutputTokens: 460800,
    providers: [{ id: "atlas-cloud", name: "AtlasCloud", retention: NO_TRAINING_RETENTION, dataPolicy: "no-training" }],
  },
]

/** OpenRouter's Free Models Router: zero price, and it sends each request to a free model it picks at random. */
export const FREE_ROUTER_ID = "openrouter/free"

/** Whether a Vector or OpenRouter model ID names free endpoints: a `:free` variant or OpenRouter's free router. */
export function isFreeModelRef(model: { providerID: string; modelID: string }) {
  const id = model.modelID.toLowerCase()
  return ["vector", "openrouter"].includes(model.providerID) && (id.endsWith(":free") || id === FREE_ROUTER_ID)
}

// Price metadata and the explicit free variant must agree; an unpriced model is not free.
export function isFreeModel(model: { providerID: string; id: string; cost?: { input: number; output: number } }) {
  return (
    isFreeModelRef({ providerID: model.providerID, modelID: model.id }) &&
    model.cost?.input === 0 &&
    model.cost.output === 0
  )
}

// Changing agents is not consent to change a free model into a paid one. Retain
// the selection even if discovery no longer offers it; the transport will refuse it.
export function retainFreeModelSelection<T extends { providerID: string; modelID: string }>(model: T | undefined) {
  return model && isFreeModelRef(model) ? model : undefined
}

/**
 * Clients from 1.99.109 label free models whose providers may train on prompts and ask before the first prompt to
 * one. They declare that by sending this value, as the `disclosure` query parameter on the catalog and the
 * disclosure header on shared chat requests. vectordev.ai serves such models only to clients that send it, so
 * 1.99.108, CLI 1.99.99 and older keep a no-training-only catalog.
 */
export const FREE_MODELS_DISCLOSURE = "may-train-v1"
export const FREE_MODELS_DISCLOSURE_HEADER = "x-vector-free-model-disclosure"
/** Sent on a shared chat request only after the user has accepted the may-train notice. */
export const FREE_MODELS_CONSENT_HEADER = "x-vector-free-model-training-consent"
export const FREE_MODELS_CONSENT_ACCEPTED = "accepted"
