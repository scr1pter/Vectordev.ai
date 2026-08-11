import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { decryptPlatformValue, encryptPlatformValue, platformAdmin, requireEntitlement } from "../_lib/platform.js"

const tables = {
  collections: "vector_api_collections",
  environments: "vector_api_environments",
  history: "vector_api_history",
} as const

function kindFrom(request: ApiRequest) {
  const kind = queryValue(request, "kind")
  if (kind === "collections" || kind === "environments" || kind === "history") return kind
  throw new ApiError(400, "DATA_KIND_INVALID", "Choose collections, environments, or history.")
}

function plainRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requireEntitlement(request)
    const kind = kindFrom(request)
    const table = tables[kind]
    const admin = platformAdmin()
    if (request.method === "GET") {
      const id = queryValue(request, "id")
      if (kind === "environments" && id) {
        const { data, error } = await admin
          .from(table)
          .select("id,name,encrypted_values,created_at,updated_at")
          .eq("id", id)
          .eq("user_id", user.id)
          .maybeSingle<{ id: string; name: string; encrypted_values: string; created_at: string; updated_at: string }>()
        if (error || !data) throw new ApiError(404, "ENVIRONMENT_NOT_FOUND", "That API environment does not exist.")
        json(response, 200, {
          item: {
            id: data.id,
            name: data.name,
            values: decryptPlatformValue(data.encrypted_values),
            created_at: data.created_at,
            updated_at: data.updated_at,
          },
        })
        return
      }
      const fields = kind === "environments" ? "id,name,created_at,updated_at" : "*"
      const { data, error } = await admin
        .from(table)
        .select(fields)
        .eq("user_id", user.id)
        .order(kind === "history" ? "created_at" : "updated_at", { ascending: false })
        .limit(kind === "history" ? 100 : 200)
      if (error) throw new ApiError(500, "DATA_LOAD_FAILED", "Vector could not load API Studio data.")
      json(response, 200, { items: data })
      return
    }
    if (request.method === "POST") {
      if (kind === "history") {
        throw new ApiError(
          405,
          "HISTORY_IMMUTABLE",
          "Execution history is written only by Vector's verified API runner.",
        )
      }
      const body = await readJson<Record<string, unknown>>(request, 512_000)
      const id = typeof body.id === "string" ? body.id : undefined
      let record: Record<string, unknown>
      if (kind === "collections") {
        const name = typeof body.name === "string" ? body.name.trim() : ""
        if (!name || name.length > 100) throw new ApiError(400, "COLLECTION_NAME_REQUIRED", "Name this collection.")
        record = {
          user_id: user.id,
          name,
          description: (typeof body.description === "string" ? body.description : "").slice(0, 2_000),
          requests: Array.isArray(body.requests) ? body.requests : [],
        }
      } else if (kind === "environments") {
        const name = typeof body.name === "string" ? body.name.trim() : ""
        if (!name || name.length > 100) throw new ApiError(400, "ENVIRONMENT_NAME_REQUIRED", "Name this environment.")
        record = { user_id: user.id, name, encrypted_values: encryptPlatformValue(plainRecord(body.values)) }
      } else throw new ApiError(405, "HISTORY_IMMUTABLE", "Execution history cannot be edited.")
      const query = id
        ? admin.from(table).update(record).eq("id", id).eq("user_id", user.id)
        : admin.from(table).insert(record)
      const { data, error } = await query
        .select(kind === "environments" ? "id,name,created_at,updated_at" : "*")
        .single()
      if (error) throw new ApiError(500, "DATA_SAVE_FAILED", "Vector could not save API Studio data.")
      json(response, 200, { item: data })
      return
    }
    if (request.method === "DELETE") {
      if (kind === "history") {
        throw new ApiError(405, "HISTORY_IMMUTABLE", "Execution evidence cannot be deleted from this endpoint.")
      }
      const body = await readJson<{ id?: string }>(request)
      if (!body.id) throw new ApiError(400, "DATA_ID_REQUIRED", "Choose an item to delete.")
      const { error } = await admin.from(table).delete().eq("id", body.id).eq("user_id", user.id)
      if (error) throw new ApiError(500, "DATA_DELETE_FAILED", "Vector could not delete that item.")
      json(response, 200, { deleted: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
