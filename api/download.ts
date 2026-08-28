import { Readable } from "node:stream"
import { get } from "@vercel/blob"
import { installerBlobPath } from "./_lib/billing.js"
import { contentTypeFor, installerFor, suggestedTarget } from "./_lib/downloads.js"
import { ApiError, handleApiError, queryValue, requireMethod, type ApiRequest, type ApiResponse } from "./_lib/http.js"

export const maxDuration = 300

// GET /api/download?target=mac-arm64   an installer, no licence, no email
// GET /api/download                    picks a build from the user agent
//
// Notably NOT rate limited through _lib/abuse: that limiter fails closed when
// Redis is unconfigured, which is exactly what makes the in-app help assistant
// return 503 today. Wiring it in here would make the download button fail for
// the same reason. Vercel's own edge protection covers the abuse case, and the
// files are large-but-static and CDN-cacheable.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const target = queryValue(request, "target") ?? suggestedTarget(request.headers?.["user-agent"] as string)
    const file = installerFor(target)

    const blob = await get(installerBlobPath(file), {
      access: "private",
      token: process.env.VECTOR_INSTALLER_BLOB_TOKEN,
      ifNoneMatch: request.headers["if-none-match"],
    })
    if (!blob) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer is not available yet.")

    response.setHeader("content-disposition", `attachment; filename="${file}"`)
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("etag", blob.blob.etag)
    // Short on purpose. These objects are overwritten in place when a release
    // ships, so a long s-maxage leaves the edge handing out the PREVIOUS build
    // for as long as it lasts — an installer swap took a full day to appear,
    // which is the opposite of what this endpoint is for. Five minutes keeps
    // the CDN useful without making a release invisible.
    response.setHeader("cache-control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60")

    if (blob.statusCode === 304) {
      response.statusCode = 304
      response.end()
      return
    }

    response.statusCode = 200
    response.setHeader("content-type", blob.blob.contentType || contentTypeFor(file))
    if (blob.blob.size) response.setHeader("content-length", `${blob.blob.size}`)
    Readable.from(blob.stream as unknown as AsyncIterable<Uint8Array>).pipe(response)
  } catch (error) {
    handleApiError(response, error)
  }
}
