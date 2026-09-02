import { claimCheckout } from "../_lib/billing.js"
import { requireAccountUser } from "../_lib/account.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const account = await requireAccountUser(request)
    const body = await readJson<{ sessionId?: string }>(request)
    const session = body.sessionId
    if (!session) throw new ApiError(400, "SESSION_REQUIRED", "The checkout session is missing.")
    json(response, 200, await claimCheckout(session, account))
  } catch (error) {
    handleApiError(response, error)
  }
}
