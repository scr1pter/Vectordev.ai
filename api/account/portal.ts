import { requireAccountUser } from "../_lib/account.js"
import { billingPortalForAccount } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const user = await requireAccountUser(request)
    json(response, 200, { url: await billingPortalForAccount(user) })
  } catch (error) {
    handleApiError(response, error)
  }
}
