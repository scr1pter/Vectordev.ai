import { Option } from "effect"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"
import { ApiError, handleApiError, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { decodeCheckin, recordUsage, usageAccount } from "../_lib/usage.js"

// The usage check-in from the desktop app and the CLI: counts and model-use totals only, see api/_lib/usage.ts. Both
// ignore every answer, so anything that is not a malformed request is a 204, recorded or not. Neither the network
// address nor the user agent is stored.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleCheckin(request, response)
}

// A full usage report is about 4 KB; this leaves room without inviting large bodies.
const MAXIMUM_BYTES = 16_384

export async function handleCheckin(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, MAXIMUM_BYTES)
    const input = Option.getOrUndefined(decodeCheckin(await readJson<unknown>(request, MAXIMUM_BYTES)))
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
    const usage = input.usage ? { usage: input.usage } : {}
    // The CLI is counted per account, so without a verified account there is nothing to attach its report to.
    if (!limited && input.client === "cli" && accountId)
      await recordUsage(
        { client: "cli", accountId, version: input.version, platform: input.platform, arch: input.arch, ...usage },
        fetcher,
      )
    if (!limited && input.client === "desktop")
      await recordUsage(
        { ...input, installId: input.installId.toLowerCase(), ...(accountId ? { accountId } : {}), ...usage },
        fetcher,
      )
    response.statusCode = 204
    response.setHeader("cache-control", "no-store")
    response.end()
  } catch (error) {
    handleApiError(response, error)
  }
}
