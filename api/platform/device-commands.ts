import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireCompanionDevice } from "../_lib/companion.js"
import { platformAdmin } from "../_lib/platform.js"

type ResultBody = { id?: string; status?: "success" | "failed" | "denied"; result?: unknown; error?: string }

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const device = await requireCompanionDevice(request)
    const admin = platformAdmin()
    await admin.from("vector_companion_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", device.id)
    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_companion_commands")
        .select("id,run_id,action,payload,risk,status,created_at")
        .eq("device_id", device.id)
        .eq("status", "queued")
        .order("created_at")
        .limit(1)
        .maybeSingle()
      if (error) throw new ApiError(500, "DEVICE_COMMAND_LOAD_FAILED", "Vector could not load computer commands.")
      if (!data) {
        json(response, 200, { command: null })
        return
      }
      const { data: claimed } = await admin
        .from("vector_companion_commands")
        .update({ status: "awaiting_approval" })
        .eq("id", data.id)
        .eq("device_id", device.id)
        .eq("status", "queued")
        .select("id,run_id,action,payload,risk,status,created_at")
        .maybeSingle()
      json(response, 200, { command: claimed || null })
      return
    }
    if (request.method === "POST") {
      const body = await readJson<ResultBody>(request, 4_000_000)
      if (!body.id || !body.status || !["success", "failed", "denied"].includes(body.status)) {
        throw new ApiError(400, "DEVICE_RESULT_INVALID", "Return a valid computer-command result.")
      }
      const { error } = await admin
        .from("vector_companion_commands")
        .update({
          status: body.status,
          result: body.result ?? null,
          error: body.error?.slice(0, 8_000) || null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", body.id)
        .eq("device_id", device.id)
        .in("status", ["awaiting_approval", "running"])
      if (error) throw new ApiError(500, "DEVICE_RESULT_FAILED", "Vector could not save the computer-command result.")
      json(response, 200, { saved: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
