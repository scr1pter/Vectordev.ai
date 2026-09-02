import { requireAccountUser } from "../_lib/account.js"
import { accountBilling, billingConfiguration } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const user = await requireAccountUser(request)
    const configuration = billingConfiguration()
    json(response, 200, {
      user,
      billing: await accountBilling(user),
      purchasesAvailable: configuration.available,
      betaAccess: !configuration.licenseRequired,
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
