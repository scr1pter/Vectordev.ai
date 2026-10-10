import { requireModelPlanUser } from "../_lib/model-plan-chat.js"
import { modelPlanStatus } from "../_lib/model-plan-account.js"
import { configuredPlanModels, modelPlansEnabled, requireModelPlans } from "../_lib/model-plan-config.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    if (!modelPlansEnabled()) {
      json(response, 200, { enabled: false, models: [] })
      return
    }
    requireModelPlans()
    const account = await requireModelPlanUser(request)
    const status = await modelPlanStatus(account.id)
    json(response, 200, { enabled: status.access, models: status.access ? configuredPlanModels() : [] })
  } catch (error) {
    handleApiError(response, error)
  }
}
