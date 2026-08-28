import { billingConfiguration } from "../_lib/billing.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { currentDownloadManifest } from "../_lib/release-downloads.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleBillingConfig(request, response, currentDownloadManifest)
}

export async function handleBillingConfig(
  request: ApiRequest,
  response: ApiResponse,
  loadManifest: typeof currentDownloadManifest,
) {
  try {
    requireMethod(request, "GET")
    const configuration = billingConfiguration()
    if (!configuration.downloads) {
      json(response, 200, configuration)
      return
    }
    const manifest = await loadManifest().catch(() => undefined)
    json(response, 200, {
      ...configuration,
      available: configuration.available && Boolean(manifest),
      downloads: Boolean(manifest),
      releaseVersion: manifest?.version,
    })
  } catch (error) {
    handleApiError(response, error)
  }
}
