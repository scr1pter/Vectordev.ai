import { activateLicense } from "../_lib/billing.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const body = await readJson<{ licenseKey: string; deviceId: string; deviceName: string; platform: string }>(request)
    json(response, 200, await activateLicense(body))
  } catch (error) {
    handleApiError(response, error)
  }
}
