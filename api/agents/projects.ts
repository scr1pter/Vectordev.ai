import { ApiError, handleApiError, json, readJson, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { platformAdmin, requirePlatformCaller } from "../_lib/platform.js"

type ProjectInput = {
  id?: string
  name?: string
  description?: string
  status?: "active" | "archived"
}

function cleanProject(body: ProjectInput) {
  const name = body.name?.trim()
  const description = body.description?.trim() || ""
  if (!name || name.length > 100) throw new ApiError(400, "PROJECT_NAME_INVALID", "Give this project a name.")
  if (description.length > 2_000) {
    throw new ApiError(400, "PROJECT_DESCRIPTION_INVALID", "Keep the project description under 2,000 characters.")
  }
  return { name, description }
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    const { user } = await requirePlatformCaller(request, request.method === "GET" ? "agents:read" : "agents:write")
    const admin = platformAdmin()

    if (request.method === "GET") {
      const { data, error } = await admin
        .from("vector_agent_projects")
        .select("id,name,description,status,created_at,updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(100)
      if (error) throw new ApiError(500, "PROJECTS_LOAD_FAILED", "Vector could not load your cloud projects.")
      json(response, 200, { projects: data || [] })
      return
    }

    if (request.method === "POST") {
      const body = await readJson<ProjectInput>(request)
      const project = cleanProject(body)
      const { data, error } = await admin
        .from("vector_agent_projects")
        .insert({ user_id: user.id, ...project })
        .select("id,name,description,status,created_at,updated_at")
        .single()
      if (error || !data) throw new ApiError(500, "PROJECT_CREATE_FAILED", "Vector could not create the project.")
      json(response, 201, { project: data })
      return
    }

    if (request.method === "PATCH") {
      const body = await readJson<ProjectInput>(request)
      if (!body.id) throw new ApiError(400, "PROJECT_REQUIRED", "Choose a project to update.")
      const updates: Record<string, string> = {}
      if (body.name !== undefined) {
        const name = body.name.trim()
        if (!name || name.length > 100) throw new ApiError(400, "PROJECT_NAME_INVALID", "Give this project a name.")
        updates.name = name
      }
      if (body.description !== undefined) {
        const description = body.description.trim()
        if (description.length > 2_000) {
          throw new ApiError(400, "PROJECT_DESCRIPTION_INVALID", "Keep the project description under 2,000 characters.")
        }
        updates.description = description
      }
      if (body.status) updates.status = body.status
      if (!Object.keys(updates).length)
        throw new ApiError(400, "PROJECT_UPDATE_EMPTY", "No project changes were provided.")
      const { data, error } = await admin
        .from("vector_agent_projects")
        .update(updates)
        .eq("id", body.id)
        .eq("user_id", user.id)
        .select("id,name,description,status,created_at,updated_at")
        .maybeSingle()
      if (error) throw new ApiError(500, "PROJECT_UPDATE_FAILED", "Vector could not update the project.")
      if (!data) throw new ApiError(404, "PROJECT_NOT_FOUND", "That project does not exist.")
      json(response, 200, { project: data })
      return
    }

    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or PATCH for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
