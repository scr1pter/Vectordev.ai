import { publicModelPlans } from "../_lib/model-plan-config.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    json(response, 200, publicModelPlans())
  } catch (error) {
    handleApiError(response, error)
  }
}
