import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { cleanProviderModels, providerDefinition, PROVIDER_CATALOG } from "../_lib/provider-catalog.js"
import { encryptPlatformValue, platformAdmin, requireEntitlement } from "../_lib/platform.js"

type ProviderBody = {
  id?: string
  providerId?: string
  name?: string
  apiKey?: string
  models?: string[]
  enabled?: boolean
}

const publicFields = "id,provider_id,name,models,enabled,last_status,last_checked_at,created_at,updated_at"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requireEntitlement(request)
    const admin = platformAdmin()
    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_model_connections")
        .select(publicFields)
        .eq("user_id", user.id)
        .order("name")
      if (error) throw new ApiError(500, "PROVIDERS_LOAD_FAILED", "Vector could not load your model providers.")
      json(response, 200, { catalog: PROVIDER_CATALOG, connections: data || [] })
      return
    }
    if (request.method === "POST") {
      const body = await readJson<ProviderBody>(request, 128_000)
      const provider = providerDefinition(body.providerId || "")
      const apiKey = body.apiKey?.trim()
      const name = body.name?.trim() || provider.name
      const models = cleanProviderModels(provider.id, body.models)
      if (!apiKey || apiKey.length < 8 || apiKey.length > 8_000) {
        throw new ApiError(400, "PROVIDER_KEY_INVALID", `Enter a valid ${provider.name} API key.`)
      }
      if (!name || name.length > 100 || !models.length) {
        throw new ApiError(400, "PROVIDER_MODELS_REQUIRED", "Add at least one model ID for this provider.")
      }
      const record = {
        user_id: user.id,
        provider_id: provider.id,
        name,
        models,
        encrypted_config: encryptPlatformValue({ apiKey, models }),
        enabled: body.enabled !== false,
        last_status: "configured",
      }
      const query = body.id
        ? admin.from("vector_model_connections").update(record).eq("id", body.id).eq("user_id", user.id)
        : admin.from("vector_model_connections").upsert(record, { onConflict: "user_id,provider_id" })
      const { data, error } = await query.select(publicFields).single()
      if (error) throw new ApiError(500, "PROVIDER_SAVE_FAILED", "Vector could not save this model provider.")
      json(response, 200, { connection: data })
      return
    }
    if (request.method === "PATCH") {
      const body = await readJson<ProviderBody>(request)
      if (!body.id || typeof body.enabled !== "boolean") {
        throw new ApiError(400, "PROVIDER_UPDATE_INVALID", "Choose a provider connection and state.")
      }
      const { error } = await admin
        .from("vector_model_connections")
        .update({ enabled: body.enabled })
        .eq("id", body.id)
        .eq("user_id", user.id)
      if (error) throw new ApiError(500, "PROVIDER_SAVE_FAILED", "Vector could not update this model provider.")
      json(response, 200, { updated: true })
      return
    }
    if (request.method === "DELETE") {
      const body = await readJson<ProviderBody>(request)
      if (!body.id) throw new ApiError(400, "PROVIDER_REQUIRED", "Choose a provider connection to remove.")
      const { error } = await admin
        .from("vector_model_connections")
        .delete()
        .eq("id", body.id)
        .eq("user_id", user.id)
      if (error) throw new ApiError(500, "PROVIDER_DELETE_FAILED", "Vector could not remove this model provider.")
      json(response, 200, { deleted: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, PATCH, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
