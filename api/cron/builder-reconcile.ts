import { refreshBuilderRun, startBuilderRun, type BuilderRun } from "../_lib/builder-agent.js"
import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { platformAdmin } from "../_lib/platform.js"

export const maxDuration = 300

function requireCron(request: ApiRequest) {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret || secret.length < 24) {
    throw new ApiError(503, "CRON_NOT_CONFIGURED", "Vector Builder's scheduler is not configured.")
  }
  if (request.headers.authorization !== "Bearer " + secret) {
    throw new ApiError(401, "CRON_UNAUTHORIZED", "This endpoint is reserved for Vector's scheduler.")
  }
}

async function inBatches<T>(items: T[], size: number, worker: (item: T) => Promise<void>) {
  let completed = 0
  let failed = 0
  for (let offset = 0; offset < items.length; offset += size) {
    const results = await Promise.allSettled(items.slice(offset, offset + size).map(worker))
    completed += results.filter((item) => item.status === "fulfilled").length
    failed += results.filter((item) => item.status === "rejected").length
  }
  return { completed, failed }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method !== "GET" && request.method !== "POST") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
    }
    requireCron(request)
    const admin = platformAdmin()
    const { data: queuedData, error: queuedError } = await admin
      .from("vector_agent_runs")
      .select("*")
      .not("project_id", "is", null)
      .eq("status", "queued")
      .order("created_at")
      .limit(16)
    if (queuedError) throw new ApiError(500, "BUILD_QUEUE_FAILED", "Vector could not load queued builds.")
    const queued = (queuedData || []) as BuilderRun[]
    const queueResult = await inBatches(queued, 4, async (run) => {
      await startBuilderRun(run)
    })

    const { data, error } = await admin
      .from("vector_agent_runs")
      .select("*")
      .not("project_id", "is", null)
      .in("status", ["starting", "running"])
      .order("updated_at")
      .limit(100)
    if (error) throw new ApiError(500, "BUILD_RECONCILE_FAILED", "Vector could not load active builds.")
    const runs = (data || []) as BuilderRun[]
    const runResult = await inBatches(runs, 5, async (run) => {
      const started = run.started_at ? new Date(run.started_at).getTime() : new Date(run.updated_at).getTime()
      if (run.status === "starting" && !run.sandbox_name && Date.now() - started > 10 * 60_000) {
        await admin
          .from("vector_agent_runs")
          .update({
            status: "failed",
            current_step: "Launch interrupted",
            error: "The Builder launch was interrupted before its workspace became available.",
            completed_at: new Date().toISOString(),
          })
          .eq("id", run.id)
          .eq("user_id", run.user_id)
          .eq("status", "starting")
        return
      }
      await refreshBuilderRun(run)
    })

    json(response, 200, {
      queuedBuilds: queued.length,
      buildsStarted: queueResult.completed,
      launchErrors: queueResult.failed,
      activeBuilds: runs.length,
      buildsReconciled: runResult.completed,
      buildErrors: runResult.failed,
      reconciledAt: new Date().toISOString(),
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
