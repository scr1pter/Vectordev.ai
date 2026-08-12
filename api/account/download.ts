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
import { accessGrantDownloadUrl, requireEntitlement } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const { user, subscription, grant, entitlement } = await requireEntitlement(request)
    const body = await readJson<{ target?: string }>(request)
    if (!body.target) throw new ApiError(400, "DOWNLOAD_TARGET_REQUIRED", "Choose a Vector installer.")
    const url =
      entitlement.plan === "founder" && grant
        ? accessGrantDownloadUrl(user.id, body.target)
        : subscription
          ? await accountDownload(subscription.stripe_customer_id, body.target)
          : undefined
    if (!url) throw new ApiError(403, "DOWNLOAD_FORBIDDEN", "This account cannot download Vector yet.")
    json(response, 200, { url })
  } catch (error) {
    handleApiError(response, error)
  }
}
