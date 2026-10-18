import { requireUnrevokedAccount } from "../_lib/revocation.js"
import { enforceRateLimit, requireTrustedJsonRequest, stableAbuseIdentifier } from "../_lib/abuse.js"
import { consumeDesktopCode } from "../_lib/desktop-account.js"
import { mintCliToken, mintDeletionGrant } from "../_lib/cli-token.js"
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
    const exchanged = await consumeDesktopCode(body)
    await requireUnrevokedAccount(exchanged.user.id)
    // A code made for deleting the account buys a ten-minute deletion grant and never a CLI token.
    json(
      response,
      200,
      exchanged.purpose === "delete"
        ? { ...mintDeletionGrant(exchanged.user), user: { email: exchanged.user.email } }
        : { ...mintCliToken(exchanged.user), user: exchanged.user },
    )
  } catch (error) {
    handleApiError(response, error)
  }
}
