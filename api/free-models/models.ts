import { FREE_MODELS_DISCLOSURE } from "../../packages/schema/src/free-model.js"
import { currentFreeModelCatalog } from "../_lib/free-models-catalog.js"
import { ApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    response.setHeader("access-control-allow-origin", "*")
    // Clients from 1.99.109 ask for may-train models by declaring that they label them and ask before sending.
    const disclosure =
      new URL(request.url ?? "/", "https://vectordev.ai").searchParams.get("disclosure") === FREE_MODELS_DISCLOSURE
    json(response, 200, await currentFreeModelCatalog(fetch, Date.now(), { disclosure }))
  } catch (error) {
    // The code says which case a probe is in: never refreshed, stale, invalid, or the store is down.
    json(response, error instanceof ApiError ? error.statusCode : 503, {
      error: {
        code: error instanceof ApiError ? error.code : "FREE_MODELS_CATALOG_UNAVAILABLE",
        message: "The free model catalog is temporarily unavailable.",
      },
    })
  }
}
