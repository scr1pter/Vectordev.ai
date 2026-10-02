import { suggestedTarget } from "./_lib/downloads.js"
import { requireAccountUser } from "./_lib/account.js"
import {
  handleApiError,
  json,
  queryValue,
  redirect,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "./_lib/http.js"
import { currentInstaller } from "./_lib/release-downloads.js"

export const maxDuration = 300

// Downloads are free with a Vector account: the website verifies the Supabase
// session before resolving the current installer. The installer itself is a
// large release asset, so authenticated clients request JSON first and then
// navigate directly to the checksum-verified asset instead of buffering it
// through a serverless function.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleDownload(request, response, currentInstaller)
}

export async function handleDownload(
  request: ApiRequest,
  response: ApiResponse,
  loadInstaller: typeof currentInstaller,
  authorize: typeof requireAccountUser = requireAccountUser,
) {
  try {
    requireMethod(request, "GET")
    await authorize(request)
    const userAgent = request.headers?.["user-agent"]
    const target = queryValue(request, "target") ?? suggestedTarget(Array.isArray(userAgent) ? userAgent[0] : userAgent)
    const release = await loadInstaller(target)

    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("x-vector-release", release.manifest.version)
    response.setHeader("x-vector-sha256", release.installer.sha256)
    const accept = request.headers.accept
    if ((Array.isArray(accept) ? accept.join(",") : accept)?.includes("application/json")) {
      json(response, 200, {
        url: release.installer.url,
        version: release.manifest.version,
        sha256: release.installer.sha256,
      })
      return
    }
    redirect(response, 307, release.installer.url)
  } catch (error) {
    handleApiError(response, error)
  }
}
