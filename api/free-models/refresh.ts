import { timingSafeEqual } from "node:crypto"
import { refreshFreeModelCatalog } from "../_lib/free-models-catalog.js"
import { ApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export const maxDuration = 800
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the catalog refresh job.")
    const catalog = await refreshFreeModelCatalog()
    json(response, 200, { enabled: catalog.enabled, updatedAt: catalog.updatedAt, count: catalog.models.length })
  } catch (error) {
    json(response, error instanceof ApiError ? error.statusCode : 503, {
      error: {
        code: error instanceof ApiError ? error.code : "FREE_MODELS_CATALOG_UNAVAILABLE",
        message: "The free model catalog was not refreshed.",
      },
    })
  }
}
