import { claimCheckout } from "../_lib/billing.js"
import { ApiError, handleApiError, json, queryValue, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const session = queryValue(request, "session_id")
    if (!session) throw new ApiError(400, "SESSION_REQUIRED", "The checkout session is missing.")
    json(response, 200, await claimCheckout(session))
  } catch (error) {
    handleApiError(response, error)
  }
}
