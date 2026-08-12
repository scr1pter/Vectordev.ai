import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { encryptPlatformValue, platformAdmin, requireEntitlement } from "../_lib/platform.js"
import { cloudReadyTool, TOOL_CATALOG } from "../_lib/tool-catalog.js"

type ConnectionBody = {
  id?: string
  name?: string
  kind?: "plugin" | "mcp_remote" | "mcp_local"
  pluginId?: string
  values?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
}

function cleanRecord(value: unknown, maximum = 40) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>).slice(0, maximum)
  return Object.fromEntries(
    entries
      .filter(([key, item]) => /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/.test(key) && typeof item === "string")
      .map(([key, item]) => [key, String(item).slice(0, 8_000)]),
  )
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requireEntitlement(request)
    const admin = platformAdmin()
    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_tool_connections")
        .select("id,plugin_id,name,kind,enabled,last_status,last_checked_at,created_at,updated_at")
        .eq("user_id", user.id)
        .order("name")
      if (error) throw new ApiError(500, "CONNECTIONS_FAILED", "Vector could not load your connections.")
      json(response, 200, { connections: data })
      return
    }
    if (request.method === "POST") {
      const body = await readJson<ConnectionBody>(request)
      const kind = body.kind
      const name = body.name?.trim()
      if (!kind || !name || name.length > 100) {
        throw new ApiError(400, "CONNECTION_INVALID", "Give this connection a valid name and type.")
      }
      let config: Record<string, unknown>
      let pluginId: string | null = null
      if (kind === "plugin") {
        const plugin = TOOL_CATALOG.find((entry) => entry.id === body.pluginId)
        if (!plugin) throw new ApiError(400, "PLUGIN_INVALID", "Choose a supported Vector plugin.")
        if (!cloudReadyTool(plugin)) {
          throw new ApiError(409, "PLUGIN_SETUP_REQUIRED", plugin.cloudNote)
        }
        const values = cleanRecord(body.values)
        for (const field of plugin.fields || []) {
          if (!values[field.key]) throw new ApiError(400, "PLUGIN_CREDENTIAL_REQUIRED", `${field.label} is required.`)
        }
        pluginId = plugin.id
        config = { values }
      } else if (kind === "mcp_remote") {
        let url: URL
        try {
          url = new URL(body.url || "")
        } catch {
          throw new ApiError(400, "MCP_URL_INVALID", "Enter a valid HTTPS MCP server URL.")
        }
        if (url.protocol !== "https:") throw new ApiError(400, "MCP_URL_INVALID", "Cloud MCP servers must use HTTPS.")
        if (url.username || url.password) {
          throw new ApiError(400, "MCP_URL_INVALID", "Put credentials in encrypted headers, not in the server URL.")
        }
        config = { url: url.toString(), headers: cleanRecord(body.headers) }
      } else {
        const command = Array.isArray(body.command)
          ? body.command
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
              .slice(0, 24)
          : []
        if (!command.length || command.some((value) => value.length > 500)) {
          throw new ApiError(400, "MCP_COMMAND_INVALID", "Enter the executable and its arguments as a valid command.")
        }
        if (Object.keys(cleanRecord(body.environment)).length) {
          throw new ApiError(
            409,
            "MCP_LOCAL_SECRET_UNSAFE",
            "Cloud-local MCP secrets would be visible inside the agent workspace. Use an authenticated remote MCP instead.",
          )
        }
        config = { command }
      }
      const record = {
        user_id: user.id,
        plugin_id: pluginId,
        name,
        kind,
        encrypted_config: encryptPlatformValue(config),
        enabled: body.enabled !== false,
        last_status: "configured",
      }
      const query = body.id
        ? admin.from("vector_tool_connections").update(record).eq("id", body.id).eq("user_id", user.id)
        : admin.from("vector_tool_connections").upsert(record, { onConflict: "user_id,name" })
      const { data, error } = await query
        .select("id,plugin_id,name,kind,enabled,last_status,last_checked_at,created_at,updated_at")
        .single()
      if (error) throw new ApiError(500, "CONNECTION_SAVE_FAILED", "Vector could not save the connection.")
      json(response, 200, { connection: data })
      return
    }
    if (request.method === "PATCH") {
      const body = await readJson<ConnectionBody>(request)
      if (!body.id || typeof body.enabled !== "boolean") {
        throw new ApiError(400, "CONNECTION_INVALID", "Choose a connection and state.")
      }
      const { error } = await admin
        .from("vector_tool_connections")
        .update({ enabled: body.enabled })
        .eq("id", body.id)
        .eq("user_id", user.id)
      if (error) throw new ApiError(500, "CONNECTION_SAVE_FAILED", "Vector could not update the connection.")
      json(response, 200, { updated: true })
      return
    }
    if (request.method === "DELETE") {
      const body = await readJson<ConnectionBody>(request)
      if (!body.id) throw new ApiError(400, "CONNECTION_REQUIRED", "Choose a connection to remove.")
      const { error } = await admin.from("vector_tool_connections").delete().eq("id", body.id).eq("user_id", user.id)
      if (error) throw new ApiError(500, "CONNECTION_DELETE_FAILED", "Vector could not remove the connection.")
      json(response, 200, { deleted: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, PATCH, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
