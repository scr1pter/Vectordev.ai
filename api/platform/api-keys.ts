import { randomBytes } from "node:crypto"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { hashSecret, platformAdmin, requireEntitlement } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requireEntitlement(request)
    const admin = platformAdmin()
    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_api_keys")
        .select("id,name,secret_prefix,last_four,scopes,daily_unit_limit,expires_at,last_used_at,created_at,revoked_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
      if (error) throw new ApiError(500, "API_KEYS_FAILED", "Vector could not load your API keys.")
      json(response, 200, { keys: data })
      return
    }
    if (request.method === "POST") {
      const body = await readJson<{
        name?: string
        scopes?: string[]
        dailyUnitLimit?: number
        expiresInDays?: number
      }>(request)
      const name = body.name?.trim()
      if (!name || name.length > 80) throw new ApiError(400, "API_KEY_NAME_REQUIRED", "Name this API key.")
      const allowedScopes = new Set(["agents:read", "agents:write", "api:execute"])
      const scopes = [...new Set(body.scopes?.filter((scope) => allowedScopes.has(scope)) || [...allowedScopes])]
      if (!scopes.length) throw new ApiError(400, "API_KEY_SCOPES_REQUIRED", "Choose at least one API key scope.")
      const dailyUnitLimit = Math.min(10_000, Math.max(10, Math.floor(body.dailyUnitLimit || 500)))
      const expiresInDays = Math.min(365, Math.max(1, Math.floor(body.expiresInDays || 90)))
      const { count } = await admin
        .from("vector_api_keys")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("revoked_at", null)
      if ((count || 0) >= 10) throw new ApiError(409, "API_KEY_LIMIT", "Revoke an API key before creating another one.")
      const secret = `vec_live_${randomBytes(30).toString("base64url")}`
      const { data, error } = await admin
        .from("vector_api_keys")
        .insert({
          user_id: user.id,
          name,
          secret_hash: hashSecret(secret),
          secret_prefix: secret.slice(0, 13),
          last_four: secret.slice(-4),
          scopes,
          daily_unit_limit: dailyUnitLimit,
          expires_at: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
        })
        .select("id,name,secret_prefix,last_four,scopes,daily_unit_limit,expires_at,created_at")
        .single()
      if (error) throw new ApiError(500, "API_KEY_CREATE_FAILED", "Vector could not create the API key.")
      json(response, 201, { key: data, secret })
      return
    }
    if (request.method === "DELETE") {
      const body = await readJson<{ id?: string }>(request)
      if (!body.id) throw new ApiError(400, "API_KEY_REQUIRED", "Choose an API key to revoke.")
      const { error } = await admin
        .from("vector_api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", body.id)
        .eq("user_id", user.id)
      if (error) throw new ApiError(500, "API_KEY_REVOKE_FAILED", "Vector could not revoke the API key.")
      json(response, 200, { revoked: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
