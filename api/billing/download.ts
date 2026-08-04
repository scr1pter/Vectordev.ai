import { consumeDownload } from "../_lib/billing.js"
import { ApiError, handleApiError, queryValue, redirect, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const token = queryValue(request, "token")
    const target = queryValue(request, "target")
    if (!token || !target) throw new ApiError(400, "DOWNLOAD_INVALID", "The download link is incomplete.")
    redirect(response, 302, await consumeDownload(token, target))
  } catch (error) {
    handleApiError(response, error)
  }
}
