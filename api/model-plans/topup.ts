import { requireAccountUser } from "../_lib/account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { modelTopupCheckout } from "../_lib/model-plan-account.js"
import { requireModelTopups } from "../_lib/model-plan-config.js"
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
    requireModelTopups()
    const account = await requireAccountUser(request)
    await enforceRateLimit(request, response, {
      scope: "model-topup-checkout",
      identifier: account.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const body = await readJson<{ pack?: unknown }>(request, 4096)
    if (typeof body.pack !== "string")
      throw new ApiError(400, "MODEL_TOPUP_INVALID", "Choose an available Codium credit pack.")
    json(response, 200, await modelTopupCheckout(account, body.pack))
  } catch (error) {
    handleApiError(response, error)
  }
}
