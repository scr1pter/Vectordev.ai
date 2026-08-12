import { Readable } from "node:stream"
import { get } from "@vercel/blob"
import { downloadTargets, installerBlobPath } from "../_lib/billing.js"
import { ApiError, handleApiError, queryValue, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"
import { verifyAccessGrantDownload } from "../_lib/platform.js"

export const maxDuration = 300

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "GET")
    const token = queryValue(request, "token")
    const target = queryValue(request, "target")
    if (!token || !target) throw new ApiError(400, "DOWNLOAD_INVALID", "The download link is incomplete.")
    await verifyAccessGrantDownload(token, target)
    const file = downloadTargets[target]
    if (!file) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer does not exist.")
    const blob = await get(installerBlobPath(file), {
      access: "private",
      token: process.env.VECTOR_INSTALLER_BLOB_TOKEN,
      ifNoneMatch: request.headers["if-none-match"],
    })
    if (!blob) throw new ApiError(404, "DOWNLOAD_NOT_FOUND", "That Vector installer is not available yet.")
    response.setHeader("content-disposition", `attachment; filename="${file}"`)
    response.setHeader("cache-control", "private, no-store")
    response.setHeader("x-content-type-options", "nosniff")
    response.setHeader("etag", blob.blob.etag)
    if (blob.statusCode === 304) {
      response.statusCode = 304
      response.end()
      return
    }
    response.statusCode = 200
    response.setHeader("content-type", blob.blob.contentType || "application/octet-stream")
    if (blob.blob.size) response.setHeader("content-length", `${blob.blob.size}`)
    Readable.from(blob.stream as unknown as AsyncIterable<Uint8Array>).pipe(response)
  } catch (error) {
    handleApiError(response, error)
  }
}
