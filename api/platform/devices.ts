import { randomBytes } from "node:crypto"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import {
  encryptPlatformValue,
  hashSecret,
  platformAdmin,
  requireEntitlement,
} from "../_lib/platform.js"

type DeviceBody = {
  action?: "pair" | "claim" | "revoke"
  token?: string
  id?: string
  name?: string
  platform?: string
  permissions?: string[]
}

const publicFields = "id,name,platform,permissions,status,last_seen_at,created_at,updated_at"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const body = request.method === "GET" ? ({} as DeviceBody) : await readJson<DeviceBody>(request)
    const admin = platformAdmin()
    if (request.method === "POST" && body.action === "claim") {
      const [pairingId, rawSecret] = (body.token || "").split(".")
      if (!pairingId || !rawSecret) throw new ApiError(400, "PAIRING_INVALID", "This pairing link is invalid.")
      const { data: pairing } = await admin
        .from("vector_companion_pairings")
        .select("id,user_id,secret_hash,expires_at,claimed_at")
        .eq("id", pairingId)
        .maybeSingle()
      if (
        !pairing ||
        pairing.claimed_at ||
        new Date(pairing.expires_at).getTime() <= Date.now() ||
        pairing.secret_hash !== hashSecret(rawSecret)
      ) {
        throw new ApiError(410, "PAIRING_EXPIRED", "This one-time pairing link has expired or was already used.")
      }
      const name = body.name?.trim().slice(0, 100) || "Vector desktop"
      const platform = body.platform?.trim().slice(0, 80) || "desktop"
      const permissions = [...new Set((body.permissions || ["browser"]).filter((item) => item === "browser" || item === "shell"))]
      const deviceSecret = `vec_device_${randomBytes(32).toString("base64url")}`
      const connectionName = `Computer: ${name} (${randomBytes(2).toString("hex")})`.slice(0, 100)
      const { data: connection, error: connectionError } = await admin
        .from("vector_tool_connections")
        .insert({
          user_id: pairing.user_id,
          plugin_id: "computer-use",
          name: connectionName,
          kind: "plugin",
          encrypted_config: encryptPlatformValue({ pendingDevice: true }),
          enabled: true,
          last_status: "connected",
        })
        .select("id")
        .single()
      if (connectionError || !connection) throw new ApiError(500, "DEVICE_CONNECT_FAILED", "Vector could not connect this computer.")
      const { data: device, error: deviceError } = await admin
        .from("vector_companion_devices")
        .insert({
          user_id: pairing.user_id,
          connection_id: connection.id,
          name,
          platform,
          permissions,
          secret_hash: hashSecret(deviceSecret),
          last_seen_at: new Date().toISOString(),
        })
        .select(publicFields)
        .single()
      if (deviceError || !device) {
        await admin.from("vector_tool_connections").delete().eq("id", connection.id)
        throw new ApiError(500, "DEVICE_CONNECT_FAILED", "Vector could not connect this computer.")
      }
      await admin
        .from("vector_tool_connections")
        .update({ encrypted_config: encryptPlatformValue({ deviceId: device.id }) })
        .eq("id", connection.id)
      await admin.from("vector_companion_pairings").update({ claimed_at: new Date().toISOString() }).eq("id", pairing.id)
      json(response, 200, {
        device,
        credential: `${device.id}.${deviceSecret}`,
        apiBase: (process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai").replace(/\/$/, ""),
      })
      return
    }

    const { user } = await requireEntitlement(request)
    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_companion_devices")
        .select(publicFields)
        .eq("user_id", user.id)
        .neq("status", "revoked")
        .order("created_at", { ascending: false })
      if (error) throw new ApiError(500, "DEVICES_LOAD_FAILED", "Vector could not load paired computers.")
      json(response, 200, { devices: data || [] })
      return
    }
    if (request.method === "POST" && body.action === "pair") {
      const secret = randomBytes(32).toString("base64url")
      const { data, error } = await admin
        .from("vector_companion_pairings")
        .insert({
          user_id: user.id,
          secret_hash: hashSecret(secret),
          expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
        })
        .select("id,expires_at")
        .single()
      if (error || !data) throw new ApiError(500, "PAIRING_CREATE_FAILED", "Vector could not create a pairing link.")
      json(response, 200, { url: `vector://companion/pair?token=${encodeURIComponent(`${data.id}.${secret}`)}`, expiresAt: data.expires_at })
      return
    }
    if (request.method === "DELETE" || (request.method === "POST" && body.action === "revoke")) {
      if (!body.id) throw new ApiError(400, "DEVICE_REQUIRED", "Choose a computer to disconnect.")
      const { data: device } = await admin
        .from("vector_companion_devices")
        .select("id,connection_id")
        .eq("id", body.id)
        .eq("user_id", user.id)
        .maybeSingle()
      if (!device) throw new ApiError(404, "DEVICE_NOT_FOUND", "That paired computer does not exist.")
      await admin.from("vector_companion_devices").update({ status: "revoked" }).eq("id", device.id)
      if (device.connection_id) await admin.from("vector_tool_connections").delete().eq("id", device.connection_id)
      json(response, 200, { revoked: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
