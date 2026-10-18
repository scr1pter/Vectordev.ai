import { FREE_ROUTER_ID, type FreeDataPolicy } from "@vectordevai/schema/free-model"

/** Presentation uses server-approved metadata, never price or an ID suffix as enablement. */
export type FreeModelChoice = {
  id: string
  name: string
  freeModel?: { source: "shared" | "openrouter"; dataPolicy?: FreeDataPolicy }
}

export const FREE_MODELS_TITLE = "Free models inside of Vector"
/** How the no-training providers behind Free models inside of Vector treat request content. */
export const FREE_MODELS_DATA_POLICY =
  "Vector doesn't request zero data retention for these models, so their providers may keep prompts and outputs under their own policies. Every request to a no-training model asks that they are not used for training."
/** The short label on every free model whose provider may train on prompts, or whose policy Vector has not reviewed. */
export const FREE_MODEL_TRAINING_LABEL = "May train on your prompts"
export const FREE_MODEL_TRAINING_DISCLAIMER =
  "This free model's provider may log your prompts, code and outputs and use them to train its models. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data."
/** OpenRouter's Free Models Router may pick any free model, so its notice says so and names the one gap Vector knows. */
export const FREE_ROUTER_DISCLAIMER =
  "OpenRouter's Free Models Router sends each request to a free model it picks at random, and that model's provider may log your prompts, code and outputs and use them to train its models. Vector asks OpenRouter to skip NVIDIA's trial endpoints, but OpenRouter doesn't say whether the router honours that. Vector itself never trains on your prompts. Don't use it with private repositories, secrets or personal data."
export const FREE_MODEL_UNREVIEWED_DISCLAIMER =
  "Vector has not reviewed this free model's data policy yet, so treat it as one whose provider may train on your prompts and code. Vector itself never trains on your prompts."
/**
 * Said wherever Vector asks: the question names one model, but one acceptance covers every labelled model, including
 * unreviewed ones, until it is withdrawn.
 */
export const FREE_MODEL_TRAINING_SCOPE = `Accepting covers every free model labelled "${FREE_MODEL_TRAINING_LABEL}", including ones Vector has not reviewed yet, now and later. Withdraw it any time with "vector models --decline-training", or with Withdraw in the desktop app's Help panel.`
/** Shown, and sent as the error, when a prompt to such a model is stopped because it was never accepted. */
export const FREE_MODEL_TRAINING_CONSENT_REQUIRED = `${FREE_MODEL_TRAINING_DISCLAIMER} Nothing was sent. Accept it once when Vector asks, or run "vector models --accept-training", then send again.`
/**
 * An invited guest's prompts run on the owner's engine, under the owner's acceptance, which the guest never gave. Such
 * models are left out of a guest's lists, and a guest's prompt to one is refused before it is saved.
 */
export const FREE_MODEL_TRAINING_OWNER_ONLY = `Only the workspace owner can use free models labelled "${FREE_MODEL_TRAINING_LABEL}" here, since only they can accept that notice. Choose another model.`
/**
 * Sent as the error when a request for a session an invited guest has worked in would go to such a model, whoever sent
 * it: the guest's input is part of what every later request in that session sends.
 */
export const FREE_MODEL_TRAINING_GUEST_SESSION = `An invited guest has worked in this session, and only the workspace owner can accept the "${FREE_MODEL_TRAINING_LABEL}" notice, so Vector doesn't send this session to free models with that label. Nothing was sent. Choose another model.`
/** OpenRouter has separate privacy settings for free and paid models; the free one decides whether these route at all. */
export const FREE_MODEL_TRAINING_BLOCKED =
  'Your OpenRouter privacy settings block free models whose providers may train on prompts. To use this one, open openrouter.ai/settings/privacy, allow free models from providers that may train on your data, then send again. Or choose a model without the "May train on your prompts" label.'
/**
 * Sent as the error when a model would reach OpenRouter's free endpoints without being one of the reviewed free models,
 * such as a free model configured under another name: it would skip the guest rule, the training notice and
 * data_collection.
 */
export const FREE_MODEL_UNLISTED = `This model runs on OpenRouter's free endpoints but isn't one of the ${FREE_MODELS_TITLE}, so Vector doesn't send it. Nothing was sent. Choose a model from ${FREE_MODELS_TITLE}.`
/**
 * Sent as the error when a request to OpenRouter outside the free-model route carries settings that let OpenRouter
 * answer with another model (openRouterModelRouting), which could be one of its free models outside the free-model
 * checks.
 */
export function openRouterRoutingRefused(fields: readonly string[]) {
  return `This model's configuration sets ${[...new Set(fields)].join(", ")} for OpenRouter, which lets OpenRouter answer with another model, possibly one of its free models outside the checks for ${FREE_MODELS_TITLE}, so Vector doesn't send it. Nothing was sent. Remove that from the model's or its provider's configuration.`
}
/** Vector itself asks for no-training routing for a model it has not reviewed, so no account setting can lift it. */
export const FREE_MODEL_UNREVIEWED_BLOCKED =
  "Vector has not reviewed this free model's data policy yet, so it asks OpenRouter to route it only to providers that don't train on prompts, and none of this model's providers qualifies. Choose another free model."
/**
 * Free models run on Vector's shared allowance, on Vector's own OpenRouter account, for every signed-in Vector user
 * (owner decision, 17 October 2026). The free-model flow never asks anyone to connect an OpenRouter account of their
 * own; connecting one stays an ordinary provider choice in Settings → Providers, described by OPENROUTER_ACCOUNT_COPY
 * there only.
 */
export const FREE_MODELS_SIGN_IN = "Sign in to Vector to use free models."
/** The same, where the way to sign in is the terminal: the TUI, the CLI and an engine without the desktop app. */
export const FREE_MODELS_SIGN_IN_TERMINAL = "Sign in to Vector to use free models: run vector login."
export const FREE_MODELS_SHARED_COPY =
  "Free models run on Vector's shared allowance at no cost to you, within a daily limit for each account. Requests pass through vectordev.ai to OpenRouter, and OpenRouter and the model's provider process your prompts."
/** What to do when the shared allowance is used up or unavailable: the user's own provider keys, not one provider. */
export const FREE_MODELS_OWN_KEYS =
  "To keep working now, choose a model from another provider you've connected, or add your own provider key in Settings → Providers."
export const FREE_MODELS_OWN_KEYS_TERMINAL =
  "To keep working now, choose a model from another provider you've connected, or connect your own provider key with /connect or vector providers login."
/** Sent by the engine and vectordev.ai, so it names no client's settings. */
export const FREE_MODELS_UNAVAILABLE = `${FREE_MODELS_TITLE} are temporarily unavailable. Try again later, or use a model from a provider you've connected with your own key.`
/**
 * Resuming a paused free-model turn runs it on an OpenRouter account the user already connected. Without one, the
 * notice says what else to do instead of asking them to connect one.
 */
export const FREE_MODEL_RESUME_UNAVAILABLE =
  "This turn can continue only on an OpenRouter account already connected to Vector that lists the same free model. Wait for the shared allowance to reset, or choose another model."
/** Describes connecting OpenRouter in its own connect flow, which the free-model flow never offers. */
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

/**
 * Why an acceptance was not recorded. The engine refuses it from an invited guest (403), for whom retrying can never
 * work, so a guest is told that only the owner can use these models.
 */
export function freeModelTrainingRefusal(status: number | undefined) {
  return status === 403 ? FREE_MODEL_TRAINING_OWNER_ONLY : "Vector couldn't record your choice. Try again."
}

/** The longer disclaimer that goes with the label. */
export function freeModelTrainingDisclaimer(model: Pick<FreeModelChoice, "freeModel"> & { id?: string }) {
  if (model.freeModel?.dataPolicy === "may-train" && model.id === FREE_ROUTER_ID) return FREE_ROUTER_DISCLAIMER
  if (model.freeModel?.dataPolicy === "unreviewed") return FREE_MODEL_UNREVIEWED_DISCLAIMER
  if (model.freeModel?.dataPolicy === "may-train") return FREE_MODEL_TRAINING_DISCLAIMER
  return undefined
}

/**
 * The largest-context model served through the user's own OpenRouter account, preferring one whose provider does not
 * train on prompts: Vector never picks a "May train on your prompts" model for the user ahead of a no-training one,
 * and never OpenRouter's free router, which picks a model at random. Price and `:free` suffixes are never treated as
 * eligibility; only server-approved metadata is, so a paid or shared model can never be chosen here. The desktop app
 * and the TUI both choose with it.
 */
export function bestOwnFreeModel<T extends Pick<FreeModelChoice, "id" | "freeModel"> & { limit: { context: number } }>(
  models: readonly T[],
) {
  return models
    .filter((model) => model.freeModel?.source === "openrouter" && model.id !== FREE_ROUTER_ID)
    .toSorted(
      (a, b) => Number(freeModelMayTrain(a)) - Number(freeModelMayTrain(b)) || b.limit.context - a.limit.context,
    )[0]
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

/** The whole notice: what happened, when the shared allowance is expected to reset, and the user's own keys. */
export function freeModelsLimitMessage(
  limit: FreeModelsLimitNotice,
  options: { locale?: string; terminal?: boolean } = {},
) {
  return `${freeModelsLimitTitle(limit)}. The shared allowance is expected to reset at ${freeModelsResetLabel(limit, options.locale)}. ${options.terminal ? FREE_MODELS_OWN_KEYS_TERMINAL : FREE_MODELS_OWN_KEYS}`
}
