import {
  continueBuilderRun,
  deleteBuilderWorkspace,
  refreshBuilderRun,
  stopBuilderRun,
  type BuilderRun,
} from "../_lib/builder-agent.js"
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
  if (!id) throw new ApiError(400, "BUILD_ID_REQUIRED", "Choose a Builder session.")
  const { data, error } = await platformAdmin()
    .from("vector_agent_runs")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .not("project_id", "is", null)
    .maybeSingle<BuilderRun>()
  if (error || !data) throw new ApiError(404, "BUILD_NOT_FOUND", "That Builder session does not exist.")
  return data
}

export const maxDuration = 120

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requirePlatformCaller(request)
    const body =
      request.method === "GET"
        ? undefined
        : await readJson<{ id?: string; action?: string; prompt?: string }>(request, 128_000)
    const run = await ownedRun(user.id, queryValue(request, "id") || body?.id)
    if (request.method === "GET") {
      const current = await refreshBuilderRun(run)
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
      await stopBuilderRun(run)
      json(response, 200, { stopped: true })
      return
    }
    if (request.method === "POST" && body?.action === "continue") {
      const prompt = body.prompt?.trim()
      if (!prompt || prompt.length > 50_000) {
        throw new ApiError(400, "PROMPT_REQUIRED", "Enter a follow-up for Vector Builder.")
      }
      if (!["complete", "failed", "needs_input"].includes(run.status) || !run.sandbox_name || !run.workspace_dir) {
        throw new ApiError(409, "BUILD_NOT_RESUMABLE", "This build is not ready for another turn.")
      }
      const limits = platformUsageLimits()
      await consumePlatformQuota({
        userId: user.id,
        kind: "builder_turn_30d",
        limit: limits.builderTurns30Days,
        windowSeconds: 30 * 86_400,
        message: "This account used its included Builder follow-ups for the last 30 days.",
        metadata: { runId: run.id, model: run.model },
      })
      const admin = platformAdmin()
      const { data: message, error: messageError } = await admin
        .from("vector_agent_messages")
        .insert({ run_id: run.id, user_id: user.id, role: "user", content: prompt })
        .select("id")
        .single<{ id: string }>()
      if (messageError) throw new ApiError(500, "BUILD_MESSAGE_FAILED", "Vector could not save the follow-up.")
      try {
        await continueBuilderRun(run, prompt)
      } catch (error) {
        if (message) await admin.from("vector_agent_messages").delete().eq("id", message.id).eq("user_id", user.id)
        throw error
      }
      json(response, 202, { started: true })
      return
    }
    if (request.method === "DELETE") {
      if (run.status === "running" || run.status === "starting") await stopBuilderRun(run)
      await deleteBuilderWorkspace(run)
      const { error } = await platformAdmin().from("vector_agent_runs").delete().eq("id", run.id).eq("user_id", user.id)
      if (error) throw new ApiError(500, "BUILD_DELETE_FAILED", "Vector could not remove the build workspace.")
      json(response, 200, { deleted: true })
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
