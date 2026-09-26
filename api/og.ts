import { enforceRateLimit } from "./_lib/abuse.js"
import { ApiError, json, type ApiRequest, type ApiResponse } from "./_lib/http.js"
import { renderSocialCard } from "./_lib/social-card.js"
import { SOCIAL_CARD_ENABLED, validSocialTitle } from "../packages/web/src/lib/social-card.js"

export const config = { api: { bodyParser: false } }

export default async function handler(request: ApiRequest, response: ApiResponse) {
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "no-referrer")
  try {
    if (request.method !== "GET") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET for a social card.")
    if (process.env[SOCIAL_CARD_ENABLED] !== "true")
      throw new ApiError(404, "SOCIAL_CARDS_DISABLED", "Social cards are not enabled.")
    const url = request.url ?? ""
    if (
      url.length > 1_024 ||
      Number(request.headers["content-length"] ?? 0) !== 0 ||
      request.headers["transfer-encoding"]
    )
      throw invalid()
    const query = new URL(url, "https://vectordev.ai").searchParams
    const title = query.get("title")
    if (!title || !validSocialTitle(title) || query.size !== 1) throw invalid()
    await enforceRateLimit(request, response, {
      scope: "social-card",
      limit: 30,
      windowSeconds: 60,
      requirePersistent: true,
    })
    const bytes = await renderSocialCard(title)
    if (response.destroyed) return
    response.statusCode = 200
    response.setHeader("content-type", "image/png")
    response.setHeader("cache-control", "public, max-age=86400, s-maxage=86400, no-transform")
    response.setHeader("content-length", bytes.byteLength)
    response.end(bytes)
  } catch (error) {
    request.resume()
    if (response.destroyed) return
    const known =
      error instanceof ApiError
        ? error
        : new ApiError(503, "SOCIAL_CARD_UNAVAILABLE", "The social card could not be rendered.")
    json(response, known.statusCode, { error: { code: known.code, message: known.message } })
  }
}

function invalid() {
  return new ApiError(400, "SOCIAL_CARD_INVALID", "Provide one title of 1 to 120 printable ASCII characters.")
}
