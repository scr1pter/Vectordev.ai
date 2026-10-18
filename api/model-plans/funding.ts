import { timingSafeEqual } from "node:crypto"
import { checkCodiumFunding } from "../_lib/codium-funding.js"
import { modelPlansEnabled } from "../_lib/model-plan-config.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export const maxDuration = 60
/** The scheduled funding check: pauses or reopens Codium sales against Vector's OpenRouter balance. */
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(String(request.headers.authorization ?? ""))
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the Codium funding job.")
    if (!modelPlansEnabled()) return json(response, 200, { enabled: false })
    const funding = await checkCodiumFunding()
    // Cron logs keep the outcome only; the amounts stay in the store and the owner's email.
    json(response, 200, { enabled: true, status: funding.status, ran: funding.ran, notified: funding.notified })
  } catch (error) {
    handleApiError(response, error)
  }
}
