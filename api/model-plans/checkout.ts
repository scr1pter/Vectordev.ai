import { requireAccountUser } from "../_lib/account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { modelPlanCheckout } from "../_lib/model-plan-account.js"
import { requireModelPlans } from "../_lib/model-plan-config.js"
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
    requireTrustedJsonRequest(request, 4096)
    requireModelPlans()
    const account = await requireAccountUser(request)
    await enforceRateLimit(request, response, {
      scope: "model-plan-checkout",
      identifier: account.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const body = await readJson<{ plan?: unknown }>(request, 4096)
    if (typeof body.plan !== "string")
      throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Vector model plan.")
    json(response, 200, await modelPlanCheckout(account, body.plan))
  } catch (error) {
    handleApiError(response, error)
  }
}
