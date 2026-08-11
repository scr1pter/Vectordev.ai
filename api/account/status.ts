import { billingConfiguration } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { entitlementFor, requireUser, subscriptionForUser } from "../_lib/platform.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const user = await requireUser(request)
    const subscription = await subscriptionForUser(user.id)
    json(response, 200, {
      user: {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split("@")[0],
        avatarUrl: user.user_metadata?.avatar_url,
      },
      entitlement: entitlementFor(subscription),
      canManageBilling: Boolean(subscription?.stripe_customer_id),
      billing: billingConfiguration(),
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
