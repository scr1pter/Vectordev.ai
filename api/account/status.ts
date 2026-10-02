import { requireAccountUser } from "../_lib/account.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    json(response, 200, { user: await requireAccountUser(request) })
  } catch (error) {
    handleApiError(response, error)
  }
}
