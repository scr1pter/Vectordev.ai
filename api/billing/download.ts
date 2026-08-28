import { consumeDownload } from "../_lib/billing.js"
import {
  ApiError,
  handleApiError,
  queryValue,
  redirect,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { currentInstaller } from "../_lib/release-downloads.js"

export const maxDuration = 300

export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleBillingDownload(request, response, { consumeDownload, currentInstaller })
}

export async function handleBillingDownload(
  request: ApiRequest,
  response: ApiResponse,
  dependencies: {
    consumeDownload: typeof consumeDownload
    currentInstaller: typeof currentInstaller
  },
) {
  try {
    requireMethod(request, "GET")
    const token = queryValue(request, "token")
    const target = queryValue(request, "target")
    if (!token || !target) throw new ApiError(400, "DOWNLOAD_INVALID", "The download link is incomplete.")
    const installer = await dependencies.consumeDownload(token, target)
    const release = await dependencies.currentInstaller(target)
    if (release.installer.filename !== installer.file) {
      throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer is not available yet.")
    }
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("x-vector-release", release.manifest.version)
    response.setHeader("x-vector-sha256", release.installer.sha256)
    redirect(response, 307, release.installer.url)
  } catch (error) {
    handleApiError(response, error)
  }
}
