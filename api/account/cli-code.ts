import { requireUnrevokedAccount } from "../_lib/revocation.js"
import { requireAccountUser } from "../_lib/account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { mintDesktopCode } from "../_lib/desktop-account.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 2_000)
    await enforceRateLimit(request, response, {
      scope: "desktop-code-ip",
      limit: 20,
      windowSeconds: 300,
      requirePersistent: true,
    })
    const user = await requireAccountUser(request)
    await requireUnrevokedAccount(user.id)
    await enforceRateLimit(request, response, {
      scope: "desktop-code-account",
      identifier: user.id,
      limit: 10,
      windowSeconds: 300,
      requirePersistent: true,
    })
    json(response, 200, await mintDesktopCode(user, await readJson(request, 2_000)))
  } catch (error) {
    handleApiError(response, error)
  }
}
