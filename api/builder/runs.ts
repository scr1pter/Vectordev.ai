import { waitUntil } from "@vercel/functions"
import {
  availableBuilderModels,
  resolveBuilderProvider,
  startBuilderRun,
  validateBuilderConnections,
  type BuilderRun,
} from "../_lib/builder-agent.js"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { consumePlatformQuota, platformAdmin, platformUsageLimits, requirePlatformCaller } from "../_lib/platform.js"

type CreateRun = {
  projectId?: string
  name?: string
  prompt?: string
  repositoryUrl?: string
  repositoryBranch?: string
  model?: string
  providerConnectionId?: string
  selectedTools?: string[]
}

export const maxDuration = 300

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requirePlatformCaller(request)
    const admin = platformAdmin()
    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_agent_runs")
        .select("*")
        .eq("user_id", user.id)
        .not("project_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(100)
      if (error) throw new ApiError(500, "BUILDS_LOAD_FAILED", "Vector could not load your Builder sessions.")
      json(response, 200, { runs: data || [], models: availableBuilderModels() })
      return
    }
    if (request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
    }
    const body = await readJson<CreateRun>(request, 128_000)
    const prompt = body.prompt?.trim()
    const name = body.name?.trim() || prompt?.split(/\s+/).slice(0, 7).join(" ")
    if (!body.projectId) throw new ApiError(400, "PROJECT_REQUIRED", "Choose a Builder project.")
    if (!prompt || prompt.length > 50_000 || !name || name.length > 100) {
      throw new ApiError(400, "BUILD_PROMPT_INVALID", "Describe the product or change you want Vector to build.")
    }
    const { data: project } = await admin
      .from("vector_agent_projects")
      .select("id")
      .eq("id", body.projectId)
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle()
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "That Builder project is unavailable.")
    const { count } = await admin
      .from("vector_agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .not("project_id", "is", null)
      .in("status", ["queued", "starting", "running", "needs_input"])
    const limits = platformUsageLimits()
    if ((count || 0) >= limits.activeBuilderRuns) {
      throw new ApiError(
        409,
        "BUILDER_LIMIT",
        "Vector supports up to " + limits.activeBuilderRuns + " active builds.",
      )
    }
    const provider = await resolveBuilderProvider(user.id, body.providerConnectionId, body.model)
    const selectedTools = await validateBuilderConnections(user.id, body.selectedTools || [])
    await consumePlatformQuota({
      userId: user.id,
      kind: "builder_launch_30d",
      limit: limits.builderLaunches30Days,
      windowSeconds: 30 * 86_400,
      message: "This account used its included Builder launches for the last 30 days.",
      metadata: { model: provider.model },
    })
    const { data, error } = await admin
      .from("vector_agent_runs")
      .insert({
        user_id: user.id,
        project_id: body.projectId,
        name,
        prompt,
        repository_url: body.repositoryUrl?.trim() || null,
        repository_branch: body.repositoryBranch?.trim() || null,
        provider: provider.source,
        model: provider.model,
        status: "queued",
        current_step: "Queued",
        selected_tools: selectedTools,
        preview_status: "idle",
      })
      .select("*")
      .single<BuilderRun>()
    if (error || !data) throw new ApiError(500, "BUILD_CREATE_FAILED", "Vector could not create the build workspace.")
    const { error: messageError } = await admin
      .from("vector_agent_messages")
      .insert({ run_id: data.id, user_id: user.id, role: "user", content: prompt })
    if (messageError) {
      await admin.from("vector_agent_runs").delete().eq("id", data.id).eq("user_id", user.id)
      throw new ApiError(500, "BUILD_MESSAGE_FAILED", "Vector could not initialize the Builder session.")
    }
    waitUntil(startBuilderRun(data).catch(() => undefined))
    json(response, 201, { run: data, queued: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
