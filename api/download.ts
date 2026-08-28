import { suggestedTarget } from "./_lib/downloads.js"
import { handleApiError, queryValue, redirect, requireMethod, type ApiRequest, type ApiResponse } from "./_lib/http.js"
import { currentInstaller } from "./_lib/release-downloads.js"

export const maxDuration = 300

// GET /api/download?target=mac-arm64   an installer, no licence, no email
// GET /api/download                    picks a build from the user agent
//
// Notably NOT rate limited through _lib/abuse: that limiter fails closed when
// Redis is unconfigured, which is exactly what makes the in-app help assistant
// return 503 today. Wiring it in here would make the download button fail for
// the same reason. Vercel's own edge protection covers the abuse case, and the
// files are large-but-static and CDN-cacheable.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleDownload(request, response, currentInstaller)
}

export async function handleDownload(
  request: ApiRequest,
  response: ApiResponse,
  loadInstaller: typeof currentInstaller,
) {
  try {
    requireMethod(request, "GET")
    const userAgent = request.headers?.["user-agent"]
    const target = queryValue(request, "target") ?? suggestedTarget(Array.isArray(userAgent) ? userAgent[0] : userAgent)
    const release = await loadInstaller(target)

    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("x-vector-release", release.manifest.version)
    response.setHeader("x-vector-sha256", release.installer.sha256)
    redirect(response, 307, release.installer.url)
  } catch (error) {
    handleApiError(response, error)
  }
}
