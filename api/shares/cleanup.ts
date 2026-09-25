import { timingSafeEqual } from "node:crypto"
import { cleanupPublicShares } from "../_lib/public-shares.js"
import { ApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export const maxDuration = 60

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const supplied = Buffer.from(request.headers.authorization ?? "")
    const expected = Buffer.from(`Bearer ${process.env.CRON_SECRET ?? ""}`)
    if (!process.env.CRON_SECRET || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ApiError(401, "NOT_AUTHORIZED", "This endpoint is reserved for the public-session cleanup job.")
    await cleanupPublicShares()
    json(response, 200, { cleaned: true })
  } catch (error) {
    json(response, error instanceof ApiError ? error.statusCode : 503, {
      error: { code: "SHARE_CLEANUP_FAILED", message: "Expired public-session content was not cleaned up." },
    })
  }
}
