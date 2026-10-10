import { requireAccountUser } from "../_lib/account.js"
import { modelPlanStatus } from "../_lib/model-plan-account.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const account = await requireAccountUser(request)
    if (!process.env.STRIPE_SECRET_KEY) {
      json(response, 200, { active: false, access: false, wallet: { credits: 0, used: 0, remaining: 0 } })
      return
    }
    json(response, 200, await modelPlanStatus(account.id))
  } catch (error) {
    handleApiError(response, error)
  }
}
