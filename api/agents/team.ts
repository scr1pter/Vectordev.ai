import { waitUntil } from "@vercel/functions"
import {
  availableCloudModels,
  resolveCloudProvider,
  startCloudAgent,
  validateCloudConnections,
  type CloudAgentRun,
} from "../_lib/cloud-agent.js"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { consumePlatformQuota, platformAdmin, platformUsageLimits, requirePlatformCaller } from "../_lib/platform.js"

type Mission = { name?: string; prompt?: string }
type CreateTeam = {
  projectId?: string
  name?: string
  objective?: string
  repositoryUrl?: string
  repositoryBranch?: string
  model?: string
  providerConnectionId?: string
  selectedTools?: string[]
  missions?: Mission[]
  mode?: "coordinated" | "isolated"
}

export const maxDuration = 300

function cleanMission(value: Mission, index: number) {
  const prompt = value.prompt?.trim()
  const name = value.name?.trim() || prompt?.split(/\s+/).slice(0, 7).join(" ") || `Agent ${index + 1}`
  if (!prompt || prompt.length > 50_000 || !name || name.length > 100) {
    throw new ApiError(400, "TEAM_MISSION_INVALID", `Mission ${index + 1} needs a clear name and task.`)
  }
  return { name, prompt }
}

async function startInBatches(runs: CloudAgentRun[], size = 4) {
  const failures: Array<{ id: string; message: string }> = []
  const admin = platformAdmin()
  for (let offset = 0; offset < runs.length; offset += size) {
    const batch = runs.slice(offset, offset + size)
    const settled = await Promise.allSettled(batch.map((run) => startCloudAgent(run)))
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!
      if (result.status === "fulfilled") continue
      const run = batch[index]!
      const message = result.reason instanceof Error ? result.reason.message : "The cloud agent could not start."
      failures.push({ id: run.id, message })
      await admin
        .from("vector_agent_runs")
        .update({
          status: "failed",
          error: message,
          current_step: "Launch failed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", run.id)
    }
  }
  return failures
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requirePlatformCaller(request, "agents:write")
    const admin = platformAdmin()
    if (request.method === "PATCH") {
      const body = await readJson<{ id?: string; mode?: "coordinated" | "isolated" }>(request)
      if (!body.id || !body.mode) throw new ApiError(400, "TASK_UPDATE_INVALID", "Choose a task and work mode.")
      const { data, error } = await admin
        .from("vector_agent_teams")
        .update({ mode: body.mode })
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select("id,project_id,name,objective,mode,status,created_at,updated_at")
        .maybeSingle()
      if (error) throw new ApiError(500, "TASK_UPDATE_FAILED", "Vector could not update this task.")
      if (!data) throw new ApiError(404, "TASK_NOT_FOUND", "That task does not exist.")
      json(response, 200, { task: data })
      return
    }
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST or PATCH for this endpoint.")
    const body = await readJson<CreateTeam>(request, 900_000)
    const missions = (body.missions || []).map(cleanMission)
    const name = body.name?.trim()
    const objective = body.objective?.trim()
    if (!name || name.length > 100 || !objective || objective.length > 12_000) {
      throw new ApiError(400, "TEAM_INVALID", "Give the agent team a name and shared objective.")
    }
    if (missions.length < 1 || missions.length > 16) {
      throw new ApiError(400, "TEAM_SIZE_INVALID", "A Vector task must contain between 1 and 16 agents.")
    }

    if (body.projectId) {
      const { data: project } = await admin
        .from("vector_agent_projects")
        .select("id")
        .eq("id", body.projectId)
        .eq("user_id", user.id)
        .eq("status", "active")
        .maybeSingle()
      if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", "Choose an active project for this task.")
    }
    const { count } = await admin
      .from("vector_agent_runs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("status", ["queued", "starting", "running", "needs_input"])
    const limits = platformUsageLimits()
    const integrationAgents = body.mode === "isolated" || missions.length === 1 ? 0 : 1
    if ((count || 0) + missions.length + integrationAgents > limits.activeCloudAgents) {
      throw new ApiError(
        409,
        "AGENT_LIMIT",
        `This team would exceed Vector's limit of ${limits.activeCloudAgents} active cloud agents per account.`,
      )
    }

    const provider = await resolveCloudProvider(user.id, body.providerConnectionId, body.model)
    const model = provider.model
    const selectedTools = await validateCloudConnections(user.id, body.selectedTools || [])
    await consumePlatformQuota({
      userId: user.id,
      kind: "cloud_agent_launch_30d",
      units: missions.length + integrationAgents,
      limit: limits.cloudAgentLaunches30Days,
      windowSeconds: 30 * 86_400,
      message:
        "This account used its included cloud-agent launches for the last 30 days. Existing workspaces remain available.",
      metadata: { model, teamSize: missions.length },
    })

    const { data: team, error: teamError } = await admin
      .from("vector_agent_teams")
      .insert({
        user_id: user.id,
        project_id: body.projectId || null,
        name,
        objective,
        mode: body.mode === "isolated" ? "isolated" : "coordinated",
        status: "active",
      })
      .select("*")
      .single()
    if (teamError || !team) throw new ApiError(500, "TEAM_CREATE_FAILED", "Vector could not create the task.")

    const records = missions.map((mission) => ({
      user_id: user.id,
      team_id: team.id,
      role: "worker",
      name: mission.name,
      prompt: mission.prompt,
      repository_url: body.repositoryUrl?.trim() || null,
      repository_branch: body.repositoryBranch?.trim() || null,
      provider: provider.source,
      model,
      status: "queued",
      current_step: "Queued with team",
      selected_tools: selectedTools,
    }))
    const { data: runs, error: runsError } = await admin
      .from("vector_agent_runs")
      .insert(records)
      .select("*")
      .returns<CloudAgentRun[]>()
    if (runsError || !runs?.length) {
      await admin.from("vector_agent_teams").delete().eq("id", team.id).eq("user_id", user.id)
      throw new ApiError(500, "TEAM_RUNS_FAILED", "Vector could not create the team's isolated workspaces.")
    }

    const teamRuns: CloudAgentRun[] = runs
    const { error: messagesError } = await admin
      .from("vector_agent_messages")
      .insert(teamRuns.map((run) => ({ run_id: run.id, user_id: user.id, role: "user", content: run.prompt })))
    if (messagesError) {
      await admin.from("vector_agent_runs").delete().eq("team_id", team.id).eq("user_id", user.id)
      await admin.from("vector_agent_teams").delete().eq("id", team.id).eq("user_id", user.id)
      throw new ApiError(500, "TEAM_MESSAGES_FAILED", "Vector could not initialize the team's sessions.")
    }

    const launch = startInBatches(teamRuns)
      .then(async (failures) => {
        if (failures.length === teamRuns.length) {
          await admin.from("vector_agent_teams").update({ status: "review" }).eq("id", team.id).eq("user_id", user.id)
        }
      })
      .catch(() => undefined)
    waitUntil(launch)
    json(response, 201, { team, runs: teamRuns, queued: true, failures: [], models: availableCloudModels() })
  } catch (error) {
    handleApiError(response, error)
  }
}
