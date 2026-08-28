import { checksumsFromManifest } from "./_lib/downloads.js"
import { handleApiError, redirect, requireMethod, type ApiRequest, type ApiResponse } from "./_lib/http.js"
import { currentDownloadManifest } from "./_lib/release-downloads.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleDownloadChecksums(request, response, currentDownloadManifest)
}

export async function handleDownloadChecksums(
  request: ApiRequest,
  response: ApiResponse,
  loadManifest: typeof currentDownloadManifest,
) {
  try {
    requireMethod(request, "GET")
    const manifest = await loadManifest()
    response.setHeader("x-vector-release", manifest.version)
    redirect(response, 307, checksumsFromManifest(manifest))
  } catch (error) {
    handleApiError(response, error)
  }
}
