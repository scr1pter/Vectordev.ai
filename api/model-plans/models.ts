import { requireModelPlanUser } from "../_lib/model-plan-chat.js"
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
    await requireModelPlanUser(request)
    // Every signed-in account sees the catalog, so choosing a Codium model without credits leads to buying them.
    // The public /config lists the same models, and each chat request checks the balance itself, so this
    // frequently polled read never calls Stripe or OpenRouter.
    json(response, 200, { enabled: true, models: configuredPlanModels() })
  } catch (error) {
    handleApiError(response, error)
  }
}
