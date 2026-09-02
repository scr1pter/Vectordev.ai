import { createCheckout, type BillingPlan } from "../_lib/billing.js"
import { requireAccountUser } from "../_lib/account.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleCheckout(request, response)
}

export async function handleCheckout(
  request: ApiRequest,
  response: ApiResponse,
  authenticate: typeof requireAccountUser = requireAccountUser,
) {
  try {
    requireMethod(request, "POST")
    const account = await authenticate(request)
    const body = await readJson<{ termsAccepted?: boolean; plan?: BillingPlan }>(request)
    if (!body.termsAccepted) {
      json(response, 400, {
        error: { code: "TERMS_REQUIRED", message: "Accept the license and subscription terms to continue." },
      })
      return
    }
    const url = await createCheckout(account.email, body.plan, undefined, account)
    json(response, 200, { url })
  } catch (error) {
    handleApiError(response, error)
  }
}
