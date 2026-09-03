import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { verifyCliToken } from "../_lib/cli-token.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_000)
    // Generous: the CLI re-verifies once a day per machine. Protects the HMAC oracle, not users.
    // If the KV-backed limiter is not configured, verification must still work —
    // a missing rate limiter should never lock people out of `vector login`.
    await enforceRateLimit(request, response, { scope: "cli-verify-ip", limit: 120, windowSeconds: 60 * 60 }).catch(
      (error) => {
        if (error instanceof ApiError && error.code === "ABUSE_PROTECTION_UNAVAILABLE") return
        throw error
      },
    )
    const body = await readJson<{ token?: unknown }>(request, 4_000)
    const user = verifyCliToken(typeof body.token === "string" ? body.token : "")
    json(response, 200, { ok: true, user })
  } catch (error) {
    handleApiError(response, error)
  }
}
