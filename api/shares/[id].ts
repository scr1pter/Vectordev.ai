import { handleApiError, queryValue, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { publicShares } from "../_lib/public-shares.js"

export const config = { api: { bodyParser: false } }

export default async function handler(request: ApiRequest, response: ApiResponse) {
  await publicShares(request, response, queryValue(request, "id") ?? "invalid").catch((error: unknown) => {
    if (!request.readableEnded) response.setHeader("connection", "close")
    request.resume()
    handleApiError(response, error)
  })
}
