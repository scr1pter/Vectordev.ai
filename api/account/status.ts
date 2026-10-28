import { requireAccountUser } from "../_lib/account.js"
import { handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { isUsageOwner } from "../_lib/usage.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleAccountStatus(request, response)
}

// The signed-in account for /account. Whether it is the owner's is decided here, against the server's allowlist, and
// answered as a boolean, so the page never needs to know any address but the visitor's own.
export async function handleAccountStatus(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    const user = await requireAccountUser(request, fetcher)
    json(response, 200, { user, owner: isUsageOwner(user.email) })
  } catch (error) {
    handleApiError(response, error)
  }
}
