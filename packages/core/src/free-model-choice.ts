import type { FreeDataPolicy } from "@vectordevai/schema/free-model"

/** Presentation uses server-approved metadata, never price or an ID suffix as enablement. */
export type FreeModelChoice = {
  id: string
  name: string
  freeModel?: { source: "shared" | "openrouter"; dataPolicy?: FreeDataPolicy }
}

export const FREE_MODELS_TITLE = "Free models inside of Vector"
/** How the no-training providers behind Free models inside of Vector treat request content. */
export const FREE_MODELS_DATA_POLICY =
  "Not zero data retention: no-training providers may keep prompts and outputs under their own policies. Every request to them asks that they are not used for training."
/** The short label on every free model whose provider may train on prompts, or whose policy Vector has not reviewed. */
export const FREE_MODEL_TRAINING_LABEL = "May train on your prompts"
export const FREE_MODEL_TRAINING_DISCLAIMER =
  "This free model's provider may log your prompts, code and outputs and use them to train its models. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data."
export const FREE_MODEL_UNREVIEWED_DISCLAIMER =
  "Vector has not reviewed this free model's data policy yet, so treat it as one whose provider may train on your prompts and code. Vector itself never trains on your prompts."
/** Shown, and sent as the error, when a prompt to such a model is stopped because it was never accepted. */
export const FREE_MODEL_TRAINING_CONSENT_REQUIRED = `${FREE_MODEL_TRAINING_DISCLAIMER} Nothing was sent. Accept this once in Vector's model picker, or run "vector models --accept-training", then send again.`
/** OpenRouter has separate privacy settings for free and paid models; the free one decides whether these route at all. */
/** OpenRouter has separate privacy settings for free and paid models; the free one decides whether these route at all. */
export const FREE_MODEL_TRAINING_BLOCKED =
  'Your OpenRouter privacy settings block free models whose providers may train on prompts. To use this one, open openrouter.ai/settings/privacy, allow free models from providers that may train on your data, then send again. Or choose a model without the "May train on your prompts" label.'
export const OPENROUTER_ACCOUNT_COPY =
  "Use your own free OpenRouter account: up to 50 requests a day, subject to availability. No payment or credits needed. Keep automatic top-ups, default or enforced account plugins, and external provider keys disabled."
export const OPENROUTER_REMOTE_COPY =
  "OpenRouter browser sign-in requires a callback on the engine's localhost. For a remote engine, use an OpenRouter API key or connect through a local engine with the callback port forwarded."

export function freeModelName(model: Pick<FreeModelChoice, "name">) {
  return model.name
    .replace(/:free\s*$/i, "")
    .replace(/\s*\(free\)\s*$/i, "")
    .trim()
}

export function freeModelSource(model: FreeModelChoice) {
  if (model.freeModel?.source === "openrouter") return "Your OpenRouter account"
  if (model.freeModel?.source === "shared") return "Shared Vector allowance"
  return undefined
}

/** True for a free model whose provider may train on prompts, including one Vector has not reviewed. */
export function freeModelMayTrain(model: Pick<FreeModelChoice, "freeModel">) {
  return !!model.freeModel?.dataPolicy && model.freeModel.dataPolicy !== "no-training"
}

/** "May train on your prompts" for such a model; nothing for a no-training or non-free one. */
export function freeModelTrainingLabel(model: Pick<FreeModelChoice, "freeModel">) {
  return freeModelMayTrain(model) ? FREE_MODEL_TRAINING_LABEL : undefined
}

/** The longer disclaimer that goes with the label. */
export function freeModelTrainingDisclaimer(model: Pick<FreeModelChoice, "freeModel">) {
  if (model.freeModel?.dataPolicy === "unreviewed") return FREE_MODEL_UNREVIEWED_DISCLAIMER
  if (model.freeModel?.dataPolicy === "may-train") return FREE_MODEL_TRAINING_DISCLAIMER
  return undefined
}

/** Keep canonical IDs intact. The user's account takes precedence for the same model. */
export function preferOwnFreeModels<T extends FreeModelChoice>(models: readonly T[]): T[] {
  const own = new Set(models.filter((model) => model.freeModel?.source === "openrouter").map((model) => model.id))
  return models.filter((model) => model.freeModel?.source !== "shared" || !own.has(model.id))
}

export type FreeModelsLimitNotice = {
  reason: "user_daily" | "user_minute" | "shared_daily" | "upstream" | "balance"
  resetAt: number
}

/** Accept the typed V1, V2, and Effect errors, not arbitrary upstream text. */
export function freeModelsLimitNotice(error: unknown): FreeModelsLimitNotice | undefined {
  if (!error || typeof error !== "object") return
  const named = "name" in error && error.name === "FreeModelsLimitError"
  const tagged = "_tag" in error && error._tag === "FreeModelsLimitError"
  const v2 =
    "type" in error &&
    error.type === "free_models_limit" &&
    "code" in error &&
    error.code === "VECTOR_FREE_MODELS_LIMIT"
  if (!named && !tagged && !v2) return
  const data = named && "data" in error ? error.data : error
  if (!data || typeof data !== "object" || !("reason" in data) || !("resetAt" in data)) return
  const reason = data.reason
  if (
    reason !== "user_daily" &&
    reason !== "user_minute" &&
    reason !== "shared_daily" &&
    reason !== "upstream" &&
    reason !== "balance"
  )
    return
  if (
    typeof data.resetAt !== "number" ||
    !Number.isFinite(data.resetAt) ||
    data.resetAt <= 0 ||
    data.resetAt > 8_640_000_000_000_000
  )
    return
  return { reason, resetAt: data.resetAt }
}

export function freeModelsLimitTitle(limit: FreeModelsLimitNotice) {
  if (limit.reason === "user_daily") return `You've used today's shared allowance for ${FREE_MODELS_TITLE}`
  if (limit.reason === "user_minute") return "Give the shared free models a moment"
  if (limit.reason === "shared_daily") return "Today's shared free model allowance is used up"
  return "Shared free models are temporarily unavailable"
}

export function freeModelsResetLabel(limit: FreeModelsLimitNotice, locale?: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(limit.resetAt)
}
