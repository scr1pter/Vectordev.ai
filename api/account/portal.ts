import { accountBillingPortal } from "../_lib/billing.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireUser, subscriptionForUser } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const user = await requireUser(request)
    const subscription = await subscriptionForUser(user.id)
    if (!subscription)
      throw new ApiError(404, "BILLING_ACCOUNT_MISSING", "This Vector account does not have a billing profile yet.")
    json(response, 200, { url: await accountBillingPortal(subscription.stripe_customer_id) })
  } catch (error) {
    handleApiError(response, error)
  }
}
