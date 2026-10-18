import { Option, Schema } from "effect"
import { FREE_MODEL_FALLBACKS, FreeModelCatalog, type FreeModelInfo } from "../../packages/schema/src/free-model.js"
import {
  FreeModelMetadata,
  barredFreeModel,
  freeEndpointPolicy,
  freeModelDataPolicy,
  freeModelInfo,
  isFreeModelID,
  isFreeRouter,
  offeredFreeModel,
  personalOnlyFreeModel,
  reviewedFreeModel,
} from "../../packages/core/src/free-model-catalog.js"
import { FREE_MODELS_UNAVAILABLE } from "../../packages/core/src/free-model-choice.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

// Never revive a catalog selected under an earlier policy (retired provider-policy endpoint, then ZDR, then the
// no-training-only allowlist, whose providers carry no data policy).
export const FREE_MODELS_CATALOG_KEY = "vector:free-models:catalog:v4:policy"

const ROOT = "https://openrouter.ai/api/v1"
// The refresh runs once a day. Two missed runs, not one, take the section down.
const MAX_AGE = 54 * 60 * 60 * 1000
const EndpointList = Schema.Struct({ data: Schema.Struct({ endpoints: Schema.Array(Schema.Unknown) }) })
export const freeModelsEnabled = () => process.env.FREE_MODELS_ENABLED === "true"

export function openRouterHeaders() {
  const key = process.env.OPENROUTER_FREE_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim()
  if (!key) throw new ApiError(503, "FREE_MODELS_UNAVAILABLE", FREE_MODELS_UNAVAILABLE)
  return {
    authorization: `Bearer ${key}`,
    "HTTP-Referer": "https://vectordev.ai/",
    "X-OpenRouter-Title": "Vector",
    "content-type": "application/json",
  }
}

async function read<T>(url: string, schema: Schema.Decoder<T>, request: typeof fetch, authenticated = false) {
  const response = await request(url, {
    headers: authenticated ? openRouterHeaders() : { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok)
    throw new ApiError(503, "FREE_MODELS_CATALOG_UNAVAILABLE", "The free model catalog could not be refreshed.")
  const parsed = Schema.decodeUnknownOption(schema)(await response.json())
  if (Option.isNone(parsed))
    throw new ApiError(503, "FREE_MODELS_CATALOG_INVALID", "The free model catalog could not be verified.")
  return parsed.value
}

export async function refreshFreeModelCatalog(
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<FreeModelCatalog> {
  if (!freeModelsEnabled()) return { enabled: false, updatedAt: 0, models: [] }
  const publicModels = await read(`${ROOT}/models`, Schema.Struct({ data: Schema.Array(Schema.Unknown) }), request)
  // The account's own list applies its privacy settings: with free may-train endpoints not allowed there, those models
  // are missing and the shared catalog stays no-training only.
  const available = await read(
    `${ROOT}/models/user`,
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    request,
    true,
  )
  const allowed = new Set(available.data.map((item) => item.id))
  // The shared allowance serves reviewed models only; unreviewed and personal-only ones are offered through a user's
  // own account.
  const candidates = publicModels.data.flatMap((item) => {
    const model = Schema.decodeUnknownOption(FreeModelMetadata)(item)
    return Option.isSome(model) &&
      reviewedFreeModel(model.value.id) &&
      !personalOnlyFreeModel(model.value.id) &&
      offeredFreeModel(model.value, now) &&
      allowed.has(model.value.id)
      ? [model.value]
      : []
  })
  const failed: string[] = []
  const check = async (model: typeof FreeModelMetadata.Type) => {
    // The free router has no endpoint list of its own; its price and parameters come from its listing.
    if (isFreeRouter(model.id)) return freeModelInfo(model, [], { reviewedOnly: true })
    // The cron runs once a day, so one unreadable endpoint list drops only its own model, not the whole refresh.
    const endpoints = await read(`${ROOT}/models/${model.id}/endpoints`, EndpointList, request).catch(() => {
      failed.push(model.id)
      return undefined
    })
    return endpoints && freeModelInfo(model, endpoints.data.endpoints, { reviewedOnly: true })
  }
  // Five endpoint lists at a time, so a growing catalog never bursts OpenRouter's rate limit during the cron.
  const checked: (FreeModelInfo | undefined)[] = []
  for (const batch of Array.from({ length: Math.ceil(candidates.length / 5) }, (_, index) =>
    candidates.slice(index * 5, index * 5 + 5),
  ))
    checked.push(...(await Promise.all(batch.map(check))))
  const models = checked.filter((model): model is FreeModelInfo => model !== undefined)
  // Model IDs are public metadata; the headers and the errors behind them are never logged.
  if (failed.length) console.warn("Free model endpoint lists unavailable:", failed.join(", "))
  // With reads failing and nothing of its own left to list, the result says nothing about the models: an OpenRouter
  // outage or rate limit during the cron. Answer 503 and keep the stored catalog instead of publishing OFF.
  if (failed.length && !models.some((model) => !isFreeRouter(model.id)))
    throw new ApiError(503, "FREE_MODELS_CATALOG_UNAVAILABLE", "The free model catalog could not be refreshed.")
  // No-training models first, the long-standing ones in their reviewed order, then by ID, and the free router last.
  const order = new Map(FREE_MODEL_FALLBACKS.map((item, index) => [item.id, index]))
  models.sort(
    (a, b) =>
      Number(isFreeRouter(a.id)) - Number(isFreeRouter(b.id)) ||
      Number(freeModelDataPolicy(a) !== "no-training") - Number(freeModelDataPolicy(b) !== "no-training") ||
      (order.get(a.id) ?? 100) - (order.get(b.id) ?? 100) ||
      a.id.localeCompare(b.id),
  )
  // With every list read and nothing that qualifies, publish OFF so clients hide the section instead of showing it
  // empty. The free router lists no endpoints and picks a model at random, so it alone never keeps the section on.
  const catalog = models.some((model) => !isFreeRouter(model.id))
    ? { enabled: true, updatedAt: now, models }
    : { enabled: false, updatedAt: now, models: [] }
  await persistentStore(["SET", FREE_MODELS_CATALOG_KEY, JSON.stringify(catalog), "EX", MAX_AGE / 1000], request)
  return catalog
}

/**
 * The stored catalog, as a client may see it. Only a client that declares it labels may-train models and asks before
 * the first prompt (`disclosure`) receives them; every other client, including 1.99.108 and CLI 1.99.99, receives the
 * no-training models only.
 */
export async function currentFreeModelCatalog(
  request: typeof fetch = fetch,
  now = Date.now(),
  options: { disclosure?: boolean } = {},
): Promise<FreeModelCatalog> {
  if (!freeModelsEnabled()) return { enabled: false, updatedAt: 0, models: [] }
  const stored = await persistentStore(["GET", FREE_MODELS_CATALOG_KEY], request)
  // Distinct codes let a probe of /models tell a catalog that was never refreshed from a stale or invalid one.
  if (stored === null || stored === undefined) throw unavailable("FREE_MODELS_CATALOG_MISSING")
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(stored)
  const decoded = Option.isSome(json) ? Schema.decodeUnknownOption(FreeModelCatalog)(json.value) : Option.none()
  if (Option.isNone(decoded)) throw unavailable("FREE_MODELS_CATALOG_INVALID")
  if (decoded.value.updatedAt > now || now - decoded.value.updatedAt > MAX_AGE)
    throw unavailable("FREE_MODELS_CATALOG_STALE")
  if (
    decoded.value.models.some(
      (model) =>
        !isFreeModelID(model.id) ||
        !!barredFreeModel(model.id) ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        !model.providers.length ||
        // Every endpoint must carry the policy the reviewed record gives it, and the record must know it.
        model.providers.some(
          (provider) =>
            provider.dataPolicy === undefined ||
            provider.dataPolicy === "unreviewed" ||
            provider.dataPolicy !== freeEndpointPolicy(model.id, provider.id),
        ),
    )
  )
    throw unavailable("FREE_MODELS_CATALOG_INVALID")
  // A catalog stored before a model became personal-only must not keep serving it.
  const shared = decoded.value.models.filter((model) => !personalOnlyFreeModel(model.id))
  const models = options.disclosure ? shared : shared.filter((model) => freeModelDataPolicy(model) === "no-training")
  // A fresh refresh that found no qualifying model is a deliberate OFF answer, not an outage. The free router alone, as
  // an earlier refresh could have stored it, does not count as a qualifying model either.
  if (!decoded.value.enabled || !models.some((model) => !isFreeRouter(model.id)))
    return { enabled: false, updatedAt: decoded.value.updatedAt, models: [] }
  return { ...decoded.value, models }
}

function unavailable(code: string) {
  return new ApiError(503, code, FREE_MODELS_UNAVAILABLE)
}
