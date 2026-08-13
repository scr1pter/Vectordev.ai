import { launchBuilderPreview, type BuilderRun } from "../_lib/builder-agent.js"
import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { platformAdmin, requirePlatformCaller } from "../_lib/platform.js"

export const maxDuration = 300

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
    const { user } = await requirePlatformCaller(request)
    const body = await readJson<{ id?: string }>(request)
    if (!body.id) throw new ApiError(400, "BUILD_ID_REQUIRED", "Choose a Builder session.")
    const { data: run, error } = await platformAdmin()
      .from("vector_agent_runs")
      .select("*")
      .eq("id", body.id)
      .eq("user_id", user.id)
      .not("project_id", "is", null)
      .maybeSingle<BuilderRun>()
    if (error || !run) throw new ApiError(404, "BUILD_NOT_FOUND", "That Builder session does not exist.")
    if (!["complete", "failed"].includes(run.status)) {
      throw new ApiError(409, "BUILD_STILL_RUNNING", "Wait for Vector to finish editing before opening the preview.")
    }
    json(response, 200, { preview: await launchBuilderPreview(run) })
  } catch (error) {
    handleApiError(response, error)
  }
}
