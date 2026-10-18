import { handleModelPlanCheckout } from "../_lib/model-plan-billing.js"
import type { ApiRequest, ApiResponse } from "../_lib/http.js"

export default function handler(request: ApiRequest, response: ApiResponse) {
  return handleModelPlanCheckout(request, response)
}
