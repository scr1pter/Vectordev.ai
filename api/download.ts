import { head } from "@vercel/blob"
import { installerBlobPath } from "./_lib/billing.js"
import { installerFor, suggestedTarget } from "./_lib/downloads.js"
import { ApiError, handleApiError, queryValue, redirect, requireMethod, type ApiRequest, type ApiResponse } from "./_lib/http.js"

// GET /api/download?target=mac-arm64   an installer, no licence, no email
// GET /api/download                    picks a build from the user agent
//
// This REDIRECTS to the blob rather than streaming it back. The first version
// proxied the bytes and set s-maxage=86400, which meant Vercel's edge cached a
// 170MB response for a day: replacing an installer left the endpoint serving
// the previous build long after the new one was uploaded, which is exactly the
// bug this endpoint existed to fix. A redirect has no such window — the blob
// URL is canonical and reflects an overwrite immediately — and it keeps a
// 170MB transfer out of a serverless function that has a 300s ceiling.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const target = queryValue(request, "target") ?? suggestedTarget(request.headers?.["user-agent"] as string)
    const file = installerFor(target)

    const blob = await head(installerBlobPath(file), { token: process.env.VECTOR_INSTALLER_BLOB_TOKEN })
    if (!blob?.url) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer is not available yet.")

    // 302, not 301: which build a target points at changes with every release,
    // and a permanent redirect would be cached by browsers past that point.
    response.setHeader("cache-control", "no-store")
    redirect(response, 302, blob.url)
  } catch (error) {
    handleApiError(response, error)
  }
}
