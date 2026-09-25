import { requireUnrevokedAccount } from "../_lib/revocation.js"
import { enforceRateLimit, requireTrustedJsonRequest, stableAbuseIdentifier } from "../_lib/abuse.js"
import { consumeDesktopCode } from "../_lib/desktop-account.js"
import { mintCliToken } from "../_lib/cli-token.js"
import { handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 2_000)
    await enforceRateLimit(request, response, {
      scope: "desktop-exchange-ip",
      limit: 30,
      windowSeconds: 300,
      requirePersistent: true,
    })
    const body = await readJson<{ code?: unknown }>(request, 2_000)
    await enforceRateLimit(request, response, {
      scope: "desktop-exchange-code",
      identifier: stableAbuseIdentifier(typeof body.code === "string" ? body.code : "invalid"),
      limit: 8,
      windowSeconds: 300,
      requirePersistent: true,
    })
    const user = await consumeDesktopCode(body)
    await requireUnrevokedAccount(user.id)
    json(response, 200, { ...mintCliToken(user), user })
  } catch (error) {
    handleApiError(response, error)
  }
}
