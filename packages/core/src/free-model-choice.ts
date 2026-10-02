/** Presentation uses server-approved metadata, never price or an ID suffix as enablement. */
export type FreeModelChoice = {
  id: string
  name: string
  freeModel?: { source: "shared" | "openrouter" }
}

export const FREE_MODELS_TITLE = "Free models inside of Vector"
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
  if (limit.reason === "user_daily") return "You've used today's shared free models inside of Vector"
  if (limit.reason === "user_minute") return "Give the shared free models a moment"
  if (limit.reason === "shared_daily") return "Today's shared free model allowance is used up"
  return "Shared free models are temporarily unavailable"
}

export function freeModelsResetLabel(limit: FreeModelsLimitNotice, locale?: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(limit.resetAt)
}
