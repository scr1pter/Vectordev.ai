import { ApiError, handleApiError, json, type ApiRequest, type ApiResponse } from "./_lib/http.js"

// Desktop builds before 1.99.99 ask vectordev.ai whether they need a licence before they show any UI:
// GET /api/billing/config on every launch, and POST /api/billing/status once a key was activated.
// vercel.json rewrites both paths here. Without an answer, 1.19.x and 1.99.2 cover the whole app with a
// "License verification is offline" screen, which also hides Check for Updates. Vector is free, so both
// answers grant access. Keep this until those builds have updated.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    if (request.method === "GET") return json(response, 200, { available: false, licenseRequired: false })
    if (request.method === "POST")
      return json(response, 200, {
        access: true,
        state: "beta",
        // These builds store this answer. When a later launch cannot reach vectordev.ai they stay open for 7 days
        // after the last check, but only while expiresAt is in the future; without it an activated copy is walled
        // on its first offline launch.
        expiresAt: "2100-01-01T00:00:00.000Z",
        message: "Vector is free. Choose Check for Updates to install the latest version.",
      })
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET or POST for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
