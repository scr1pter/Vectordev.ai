import { Option } from "effect"
import { requireTrustedJsonRequest } from "../_lib/abuse.js"
import {
  ApiError,
  handleApiError,
  json,
  queryValue,
  readJson,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { createShare, decodeShareRequest, listShares, requireUsageOwner, revokeShare } from "../_lib/usage.js"

// The owner's read-only links to the usage dashboard: GET lists them, POST makes one (its link is returned once) and
// DELETE ?id= turns one off. Every method needs the same owner sign-in as the dashboard.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  await handleUsageShares(request, response)
}

export async function handleUsageShares(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    response.setHeader("x-robots-tag", "noindex, nofollow, noarchive")
    if (request.method === "GET") {
      await requireUsageOwner(request, fetcher)
      return json(response, 200, { shares: await listShares(fetcher) })
    }
    if (request.method === "POST") {
      requireTrustedJsonRequest(request, 2_048)
      await requireUsageOwner(request, fetcher)
      const input = Option.getOrUndefined(decodeShareRequest(await readJson<unknown>(request, 2_048)))
      if (!input)
        throw new ApiError(400, "SHARE_INVALID", "Give the link a label of up to 80 characters and 7, 14 or 30 days.")
      return json(response, 201, await createShare(input, fetcher))
    }
    if (request.method === "DELETE") {
      await requireUsageOwner(request, fetcher)
      await revokeShare(queryValue(request, "id") ?? "", fetcher)
      response.statusCode = 204
      response.setHeader("cache-control", "no-store")
      response.end()
      return
    }
    throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use GET, POST or DELETE for this endpoint.")
  } catch (error) {
    handleApiError(response, error)
  }
}
