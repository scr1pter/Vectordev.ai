import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { requireUsageOwner, usageSummary } from "../_lib/usage.js"

// The owner's usage dashboard (/usage): aggregate counts for the owner's Google session only.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleUsageSummary(request, response)
}

export async function handleUsageSummary(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
    await requireUsageOwner(request, fetcher)
    json(response, 200, await usageSummary(fetcher))
  } catch (error) {
    handleApiError(response, error)
  }
}
