import { requireModelPlanCaller, requireModelPlanClient } from "./model-plan-caller.js"
import { configuredPlanModels, modelPlansEnabled, requireModelPlans } from "./model-plan-config.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

export async function handleModelPlanModels(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    if (!modelPlansEnabled()) {
      json(response, 200, { enabled: false, models: [] })
      return
    }
    // Older clients cannot interpret the new paid caller contract; catalog reads remain an empty list.
    try {
      requireModelPlanClient(request)
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "CODIUM_UPDATE_REQUIRED") throw error
      json(response, 200, { enabled: false, models: [] })
      return
    }
    requireModelPlans()
    await requireModelPlanCaller(request, fetcher)
    // Every signed-in account sees the catalog, so choosing a Codium model without credits leads to buying them.
    // The public /config lists the same models, and each chat request checks the balance itself, so this
    // frequently polled read never calls Stripe or OpenRouter. Vector lists the models in this order and offers the
    // first as Codium's default. Routing policy (precision, reasoning, caching) and the price ceilings stay on the
    // server: Codium steps spend credits, never dollars Vector could add up.
    json(response, 200, {
      enabled: true,
      models: configuredPlanModels().map((model) => ({
        id: model.id,
        name: model.name,
        contextLength: model.contextLength,
        maxOutputTokens: model.maxOutputTokens,
      })),
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
