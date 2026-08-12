import { waitUntil } from "@vercel/functions"
import {
  availableCloudModels,
  requiredCloudModel,
  startCloudAgent,
  validateCloudConnections,
  type CloudAgentRun,
} from "../_lib/cloud-agent.js"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { consumePlatformQuota, platformAdmin, platformUsageLimits, requirePlatformCaller } from "../_lib/platform.js"

type CreateRun = {
  name?: string
  prompt?: string
  repositoryUrl?: string
  repositoryBranch?: string
  model?: string
  teamId?: string
  teamName?: string
  teamObjective?: string
  selectedTools?: string[]
}

export const maxDuration = 300

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requirePlatformCaller(request, request.method === "GET" ? "agents:read" : "agents:write")
    const admin = platformAdmin()
    if (request.method === "GET") {
      const [{ data, error }, { data: teams, error: teamsError }] = await Promise.all([
        admin
          .from("vector_agent_runs")
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
        admin
          .from("vector_agent_teams")
          .select("id,project_id,name,objective,mode,status,created_at,updated_at")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(100),
      ])
      if (error) throw new ApiError(500, "AGENTS_LOAD_FAILED", "Vector could not load your cloud agents.")
      if (teamsError) throw new ApiError(500, "TEAMS_LOAD_FAILED", "Vector could not load your agent teams.")
      json(response, 200, { runs: data, teams: teams || [], models: availableCloudModels() })
      return
    }
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
    const body = await readJson<CreateRun>(request, 128_000)
    const prompt = body.prompt?.trim()
    const name = body.name?.trim() || prompt?.split(/\s+/).slice(0, 7).join(" ")
    if (!prompt || prompt.length > 50_000 || !name || name.length > 100) {
      throw new ApiError(400, "AGENT_TASK_INVALID", "Give the cloud agent a clear name and task.")
    }
    const { count } = await admin
      .from("vector_agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", ["queued", "starting", "running", "needs_input"])
    const limits = platformUsageLimits()
    if ((count || 0) >= limits.activeCloudAgents) {
      throw new ApiError(
        409,
        "AGENT_LIMIT",
        `Vector supports up to ${limits.activeCloudAgents} active cloud agents per account.`,
      )
    }
    const model = requiredCloudModel(body.model)
    const selectedTools = await validateCloudConnections(user.id, body.selectedTools || [])
    await consumePlatformQuota({
      userId: user.id,
      kind: "cloud_agent_launch_30d",
      limit: limits.cloudAgentLaunches30Days,
      windowSeconds: 30 * 86_400,
      message:
        "This account used its included cloud-agent launches for the last 30 days. Existing workspaces remain available.",
      metadata: { model },
    })
    let teamId = body.teamId || null
    let createdTeamId: string | null = null
    if (!teamId && body.teamName?.trim()) {
      const { data: team, error: teamError } = await admin
        .from("vector_agent_teams")
        .insert({
          user_id: user.id,
          name: body.teamName.trim().slice(0, 100),
          objective: (body.teamObjective || prompt).slice(0, 12_000),
        })
        .select("id")
        .single()
      if (teamError) throw new ApiError(500, "TEAM_CREATE_FAILED", "Vector could not create the agent team.")
      teamId = team.id
      createdTeamId = team.id
    }
    if (teamId) {
      const { data: team } = await admin
        .from("vector_agent_teams")
        .select("id")
        .eq("id", teamId)
        .eq("user_id", user.id)
        .maybeSingle()
      if (!team) throw new ApiError(404, "TEAM_NOT_FOUND", "That agent team does not exist.")
      await admin.from("vector_agent_teams").update({ status: "active" }).eq("id", teamId).eq("user_id", user.id)
    }
    const { data, error } = await admin
      .from("vector_agent_runs")
      .insert({
        user_id: user.id,
        team_id: teamId,
        role: "worker",
        name,
        prompt,
        repository_url: body.repositoryUrl?.trim() || null,
        repository_branch: body.repositoryBranch?.trim() || null,
        provider: "vector-cloud",
        model,
        status: "queued",
        current_step: "Queued",
        selected_tools: selectedTools,
      })
      .select("*")
      .single<CloudAgentRun>()
    if (error || !data) {
      if (createdTeamId) await admin.from("vector_agent_teams").delete().eq("id", createdTeamId).eq("user_id", user.id)
      throw new ApiError(500, "AGENT_CREATE_FAILED", "Vector could not create the cloud workspace.")
    }
    const { error: messageError } = await admin
      .from("vector_agent_messages")
      .insert({ run_id: data.id, user_id: user.id, role: "user", content: prompt })
    if (messageError) {
      await admin.from("vector_agent_runs").delete().eq("id", data.id).eq("user_id", user.id)
      if (createdTeamId) await admin.from("vector_agent_teams").delete().eq("id", createdTeamId).eq("user_id", user.id)
      throw new ApiError(500, "AGENT_MESSAGE_FAILED", "Vector could not initialize the cloud agent session.")
    }
    waitUntil(startCloudAgent(data).catch(() => undefined))
    json(response, 201, { run: data, queued: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
