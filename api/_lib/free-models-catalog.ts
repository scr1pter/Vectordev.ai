import { Option, Schema } from "effect"
import { FREE_MODEL_FALLBACKS, FreeModelCatalog, type FreeModelInfo } from "../../packages/schema/src/free-model.js"
import {
  FreeModelMetadata,
  excludedFreeModel,
  freeModelInfo,
  includedFreeModel,
  isFreeModelID,
  noTrainingEndpoint,
} from "../../packages/core/src/free-model-catalog.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

// Never revive a catalog selected under an earlier policy (retired provider-policy endpoint, then ZDR).
export const FREE_MODELS_CATALOG_KEY = "vector:free-models:catalog:v3:no-training"

const ROOT = "https://openrouter.ai/api/v1"
const MAX_AGE = 30 * 60 * 60 * 1000
const EndpointList = Schema.Struct({ data: Schema.Struct({ endpoints: Schema.Array(Schema.Unknown) }) })
export const freeModelsEnabled = () => process.env.FREE_MODELS_ENABLED === "true"

export function openRouterHeaders() {
  const key = process.env.OPENROUTER_FREE_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim()
  if (!key)
    throw new ApiError(
      503,
      "FREE_MODELS_UNAVAILABLE",
      "Models included with Vector are temporarily unavailable. Connect OpenRouter to use your own account.",
    )
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
  const available = await read(
    `${ROOT}/models/user`,
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
    request,
    true,
  )
  const allowed = new Set(available.data.map((item) => item.id))
  const candidates = publicModels.data.flatMap((item) => {
    const model = Schema.decodeUnknownOption(FreeModelMetadata)(item)
    return Option.isSome(model) && includedFreeModel(model.value, now) && allowed.has(model.value.id)
      ? [model.value]
      : []
  })
  // OpenRouter publishes no per-endpoint training flag; the no-training selection keeps allowlisted model and
  // provider pairs only, and each request also asks OpenRouter to deny data collection.
  const checked = await Promise.all(
    candidates.map(async (model) => {
      // The cron runs once a day, so one unreadable endpoint list drops only its own model, not the whole refresh.
      const endpoints = await read(`${ROOT}/models/${model.id}/endpoints`, EndpointList, request).catch(() => undefined)
      return endpoints && freeModelInfo(model, endpoints.data.endpoints, { noTraining: true })
    }),
  )
  const models = checked.filter((model): model is FreeModelInfo => model !== undefined)
  const order = new Map(FREE_MODEL_FALLBACKS.map((item, index) => [item.id, index]))
  models.sort((a, b) => (order.get(a.id) ?? 100) - (order.get(b.id) ?? 100) || a.id.localeCompare(b.id))
  // With nothing that qualifies, publish OFF so clients hide the section instead of showing it empty.
  const catalog = { enabled: models.length > 0, updatedAt: now, models }
  await persistentStore(["SET", FREE_MODELS_CATALOG_KEY, JSON.stringify(catalog), "EX", 30 * 60 * 60], request)
  return catalog
}

export async function currentFreeModelCatalog(
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<FreeModelCatalog> {
  if (!freeModelsEnabled()) return { enabled: false, updatedAt: 0, models: [] }
  const stored = await persistentStore(["GET", FREE_MODELS_CATALOG_KEY], request)
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(stored)
  const decoded = Option.isSome(json) ? Schema.decodeUnknownOption(FreeModelCatalog)(json.value) : Option.none()
  if (
    Option.isNone(decoded) ||
    decoded.value.updatedAt > now ||
    now - decoded.value.updatedAt > MAX_AGE ||
    decoded.value.models.some(
      (model) =>
        !isFreeModelID(model.id) ||
        excludedFreeModel(model.id) ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        !model.providers.length ||
        model.providers.some((provider) => !noTrainingEndpoint(model.id, provider.id)),
    )
  )
    throw new ApiError(
      503,
      "FREE_MODELS_CATALOG_UNAVAILABLE",
      "Models included with Vector are temporarily unavailable. Connect OpenRouter to use your own account.",
    )
  // A fresh refresh that found no qualifying model is a deliberate OFF answer, not an outage.
  if (!decoded.value.enabled || !decoded.value.models.length)
    return { enabled: false, updatedAt: decoded.value.updatedAt, models: [] }
  return decoded.value
}
