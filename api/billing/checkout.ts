import { createCheckout, type BillingPlan } from "../_lib/billing.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireUser } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const body = await readJson<{ email?: string; termsAccepted?: boolean; plan?: BillingPlan }>(request)
    if (!body.termsAccepted) {
      json(response, 400, {
        error: { code: "TERMS_REQUIRED", message: "Accept the license and subscription terms to continue." },
      })
      return
    }
    const user = await requireUser(request)
    const url = await createCheckout(user.email || body.email, body.plan, { userId: user.id })
    json(response, 200, { url })
  } catch (error) {
    handleApiError(response, error)
  }
}
