import { accountDownload } from "../_lib/billing.js"
import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { requireEntitlement } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const { subscription } = await requireEntitlement(request)
    const body = await readJson<{ target?: string }>(request)
    if (!body.target) throw new ApiError(400, "DOWNLOAD_TARGET_REQUIRED", "Choose a Vector installer.")
    json(response, 200, { url: await accountDownload(subscription.stripe_customer_id, body.target) })
  } catch (error) {
    handleApiError(response, error)
  }
}
