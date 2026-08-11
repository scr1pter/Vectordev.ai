import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireEntitlement } from "../_lib/platform.js"
import { TOOL_CATALOG } from "../_lib/tool-catalog.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    await requireEntitlement(request)
    json(response, 200, { tools: TOOL_CATALOG })
  } catch (error) {
    handleApiError(response, error)
  }
}
