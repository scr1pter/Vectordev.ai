import { billingConfiguration } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    json(response, 200, billingConfiguration())
  } catch (error) {
    handleApiError(response, error)
  }
}
