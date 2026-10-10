import { requireAccountUser } from "../_lib/account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { modelPlanPortal } from "../_lib/model-plan-account.js"
import { modelPlansEnabled } from "../_lib/model-plan-config.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    // Keep cancellation reachable even when new model requests are disabled.
    if (!modelPlansEnabled() && !process.env.STRIPE_SECRET_KEY)
      throw new ApiError(503, "BILLING_UNAVAILABLE", "Billing is temporarily unavailable.")
    const account = await requireAccountUser(request)
    await enforceRateLimit(request, response, {
      scope: "model-plan-portal",
      identifier: account.id,
      limit: 20,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    json(response, 200, await modelPlanPortal(account.id))
  } catch (error) {
    handleApiError(response, error)
  }
}
