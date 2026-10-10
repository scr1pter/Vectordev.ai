import { enforceRateLimit } from "../_lib/abuse.js"
import { ApiError, handleApiError, json, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { openShare, requireUsageOwner, shareableSummary, shareToken, usageSummary } from "../_lib/usage.js"

// The usage dashboard (/usage): aggregate counts for the owner's Google session, or for a read-only share link whose
// token the page sends in x-vector-usage-share. A share link sees only aggregates, never who anyone is.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleUsageSummary(request, response)
}

export async function handleUsageSummary(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "GET")
    response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
    const token = shareToken(request)
    if (token === undefined) {
      await requireUsageOwner(request, fetcher)
      return json(response, 200, await usageSummary(fetcher))
    }
    if (token === null) throw new ApiError(404, "SHARE_NOT_FOUND", "This link is not valid.")
    // Tokens cannot be guessed; this only keeps one address from hammering the summary. A missing limiter must not
    // turn a valid link away.
    await enforceRateLimit(request, response, { scope: "usage-share", limit: 120, windowSeconds: 60 * 60 }).catch(
      (error: unknown) => {
        if (error instanceof ApiError && error.code === "RATE_LIMITED") throw error
      },
    )
    const shared = await openShare(token, fetcher)
    json(response, 200, { shared, summary: shareableSummary(await usageSummary(fetcher)) })
  } catch (error) {
    handleApiError(response, error)
  }
}
