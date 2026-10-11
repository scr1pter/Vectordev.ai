import { Option, Schema } from "effect"
import { FREE_MODEL_FALLBACKS, FreeModelCatalog, type FreeModelInfo } from "../../packages/schema/src/free-model.js"
import {
  FreeModelMetadata,
  eligibleFreeModel,
  freeModelInfo,
  isFreeModelID,
} from "../../packages/core/src/free-model-catalog.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

// Never revive a catalog produced by the retired provider-policy endpoint.
export const FREE_MODELS_CATALOG_KEY = "vector:free-models:catalog:v2:zdr"

const ROOT = "https://openrouter.ai/api/v1"
const MAX_AGE = 30 * 60 * 60 * 1000
const REVIEWED_PROVIDERS = new Set(["novita", "modelrun", "atlas-cloud", "poolside", "cohere"])
const EXCLUDED = /^(?:nvidia|stealth|thinkingmachines|liquid|google)\//i
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

export function isEligibleFreeModel(model: typeof FreeModelMetadata.Type, now = Date.now()) {
  return !EXCLUDED.test(model.id) && eligibleFreeModel(model, now + 7 * 86400000)
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
  const endpoints = await read(`${ROOT}/endpoints/zdr`, Schema.Struct({ data: Schema.Array(Schema.Unknown) }), request)
  const allowed = new Set(available.data.map((item) => item.id))
  const candidates = publicModels.data.flatMap((item) => {
    const model = Schema.decodeUnknownOption(FreeModelMetadata)(item)
    return Option.isSome(model) && isEligibleFreeModel(model.value, now) && allowed.has(model.value.id)
      ? [model.value]
      : []
  })
  const models: FreeModelInfo[] = []
  for (const model of candidates) {
    const info = freeModelInfo(model, endpoints.data, { zdr: true })
    if (!info) continue
    const providers = info.providers.filter((provider) => REVIEWED_PROVIDERS.has(provider.id.split("/")[0] ?? ""))
    if (providers.length) models.push({ ...info, providers })
  }
  const order = new Map(FREE_MODEL_FALLBACKS.map((item, index) => [item.id, index]))
  models.sort((a, b) => (order.get(a.id) ?? 100) - (order.get(b.id) ?? 100) || a.id.localeCompare(b.id))
  const catalog = { enabled: true, updatedAt: now, models }
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
    !decoded.value.enabled ||
    decoded.value.updatedAt > now ||
    now - decoded.value.updatedAt > MAX_AGE ||
    decoded.value.models.some(
      (model) =>
        !isFreeModelID(model.id) ||
        EXCLUDED.test(model.id) ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        !model.providers.length ||
        model.providers.some((provider) => !REVIEWED_PROVIDERS.has(provider.id.split("/")[0] ?? "")),
    )
  )
    throw new ApiError(
      503,
      "FREE_MODELS_CATALOG_UNAVAILABLE",
      "Models included with Vector are temporarily unavailable. Connect OpenRouter to use your own account.",
    )
  return decoded.value
}
