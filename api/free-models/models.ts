import { currentFreeModelCatalog } from "../_lib/free-models-catalog.js"
import { ApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    response.setHeader("access-control-allow-origin", "*")
    json(response, 200, await currentFreeModelCatalog())
  } catch (error) {
    json(response, error instanceof ApiError ? error.statusCode : 503, {
      error: { code: "FREE_MODELS_CATALOG_UNAVAILABLE", message: "The free model catalog is temporarily unavailable." },
    })
  }
}
