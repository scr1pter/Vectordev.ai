import { Option } from "effect"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { ApiError, handleApiError, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { decodeCheckin, recordUsage, usageAccount } from "../_lib/usage.js"

// The desktop app's daily usage check-in: counts only, see api/_lib/usage.ts. The app ignores
// every answer, so anything that is not a malformed request is a 204, recorded or not.
// Neither the network address nor the user agent is stored.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleCheckin(request, response)
}

export async function handleCheckin(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4_096)
    const input = Option.getOrUndefined(decodeCheckin(await readJson<unknown>(request, 4_096)))
    if (!input) throw new ApiError(400, "USAGE_INVALID", "This usage check-in is not valid.")
    // Keeps one address from inventing installs. A missing limiter must not stop counting.
    const limited = await enforceRateLimit(request, response, {
      scope: "usage-checkin",
      limit: 240,
      windowSeconds: 60 * 60,
    }).then(
      () => false,
      (error: unknown) => error instanceof ApiError && error.code === "RATE_LIMITED",
    )
    const accountId = usageAccount(request)
    if (!limited)
      await recordUsage(
        { ...input, installId: input.installId.toLowerCase(), ...(accountId ? { accountId } : {}) },
        fetcher,
      )
    response.statusCode = 204
    response.setHeader("cache-control", "no-store")
    response.end()
  } catch (error) {
    handleApiError(response, error)
  }
}
