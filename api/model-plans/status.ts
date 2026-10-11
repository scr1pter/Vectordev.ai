import { handleModelPlanStatus } from "../_lib/model-plan-status.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelPlanStatus(request, response)
}
