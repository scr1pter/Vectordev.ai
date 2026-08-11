import {
  continueCloudAgent,
  deleteCloudAgentWorkspace,
  refreshCloudAgent,
  stopCloudAgent,
  type CloudAgentRun,
} from "../_lib/cloud-agent.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { consumePlatformQuota, platformAdmin, platformUsageLimits, requirePlatformCaller } from "../_lib/platform.js"

async function ownedRun(userId: string, id?: string) {
  if (!id) throw new ApiError(400, "AGENT_ID_REQUIRED", "Choose a cloud agent.")
  const { data, error } = await platformAdmin()
    .from("vector_agent_runs")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle<CloudAgentRun>()
  if (error || !data) throw new ApiError(404, "AGENT_NOT_FOUND", "That cloud agent does not exist.")
  return data
}

export const maxDuration = 120

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requirePlatformCaller(request, request.method === "GET" ? "agents:read" : "agents:write")
    const body =
      request.method === "GET"
        ? undefined
        : await readJson<{ id?: string; action?: string; prompt?: string }>(request, 128_000)
    const id = queryValue(request, "id") || body?.id
    const run = await ownedRun(user.id, id)
    if (request.method === "GET") {
      const current = await refreshCloudAgent(run)
      const { data: messages } = await platformAdmin()
        .from("vector_agent_messages")
        .select("id,role,content,metadata,created_at")
        .eq("run_id", run.id)
        .eq("user_id", user.id)
        .order("created_at")
      json(response, 200, { run: current, messages: messages || [] })
      return
    }
    if (request.method === "POST" && body?.action === "stop") {
      await stopCloudAgent(run)
      json(response, 200, { stopped: true })
      return
    }
    if (request.method === "POST" && body?.action === "continue") {
      const prompt = body.prompt?.trim()
      if (!prompt || prompt.length > 50_000)
        throw new ApiError(400, "PROMPT_REQUIRED", "Enter a follow-up for the cloud agent.")
      if (!["complete", "failed", "needs_input"].includes(run.status) || !run.sandbox_name || !run.workspace_dir) {
        throw new ApiError(409, "AGENT_NOT_RESUMABLE", "This cloud agent is not ready for another turn.")
      }
      await consumePlatformQuota({
        userId: user.id,
        kind: "cloud_agent_turn_30d",
        limit: platformUsageLimits().cloudAgentTurns30Days,
        windowSeconds: 30 * 86_400,
        message: "This account used its included Cloud Agent follow-ups for the last 30 days.",
        metadata: { runId: run.id, model: run.model },
      })
      const admin = platformAdmin()
      const { data: message, error: messageError } = await admin
        .from("vector_agent_messages")
        .insert({ run_id: run.id, user_id: user.id, role: "user", content: prompt })
        .select("id")
        .single<{ id: string }>()
      if (messageError)
        throw new ApiError(500, "AGENT_MESSAGE_FAILED", "Vector could not save the cloud-agent follow-up.")
      try {
        await continueCloudAgent(run, prompt)
      } catch (error) {
        if (message) await admin.from("vector_agent_messages").delete().eq("id", message.id).eq("user_id", user.id)
        throw error
      }
      json(response, 202, { started: true })
      return
    }
    if (request.method === "DELETE") {
      if (run.status === "running" || run.status === "starting") await stopCloudAgent(run)
      await deleteCloudAgentWorkspace(run)
      const { error } = await platformAdmin().from("vector_agent_runs").delete().eq("id", run.id).eq("user_id", user.id)
      if (error) throw new ApiError(500, "AGENT_DELETE_FAILED", "Vector could not remove the cloud workspace.")
      json(response, 200, { deleted: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
