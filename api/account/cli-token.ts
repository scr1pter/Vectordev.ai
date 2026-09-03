import { requireAccountUser } from "../_lib/account.js"
import { mintCliToken } from "../_lib/cli-token.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const user = await requireAccountUser(request)
    json(response, 200, mintCliToken({ id: user.id, email: user.email }))
  } catch (error) {
    handleApiError(response, error)
  }
}
