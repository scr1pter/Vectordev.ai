import { clearedDesignLabCookie, designLabCookie, requireDesignLabOwner } from "../_lib/design-lab.js"
import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "../_lib/http.js"

// POST with the owner's Google session as a bearer token: issues the Design Lab cookie.
// DELETE: forgets it.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method === "DELETE") {
      response.setHeader("set-cookie", clearedDesignLabCookie())
      return json(response, 200, { ok: true })
    }
    if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.")
    const owner = await requireDesignLabOwner(request)
    response.setHeader("set-cookie", designLabCookie(owner.email))
    json(response, 200, { ok: true, path: "/design-lab/index.html" })
  } catch (error) {
    handleApiError(response, error)
  }
}
