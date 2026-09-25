import { get } from "@vercel/blob"
import { CliRelease } from "../../packages/schema/src/cli-release.js"
import { Schema } from "effect"
import { ApiError } from "./http.js"

export async function readCliManifest(stream: ReadableStream<Uint8Array>, url: string, version: string) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > CliRelease.MAX_MANIFEST_BYTES) throw new Error("Oversized manifest")
      chunks.push(part.value)
    }
    const location = new URL(url)
    if (url !== `${location.origin}/${CliRelease.manifestPath(version)}`) throw new Error("Unexpected manifest path")
    const manifest = CliRelease.decode(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString("utf8")),
      location.origin,
    )
    if (Schema.is(CliRelease.Channel)(version) ? manifest.channel !== version : manifest.version !== version)
      throw new Error("Unexpected release identity")
    return manifest
  } catch {
    throw new ApiError(503, "CLI_RELEASE_INVALID", "Vector could not verify this CLI release. Please try again later.")
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export async function currentCliManifest(version: string) {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new ApiError(503, "CLI_RELEASE_UNAVAILABLE", "Vector CLI downloads are not configured yet.")
  const blob = await get(CliRelease.manifestPath(version), {
    access: "public",
    token,
    useCache: false,
    abortSignal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new ApiError(503, "CLI_RELEASE_UNAVAILABLE", "Vector CLI downloads are temporarily unavailable.")
  })
  if (!blob || blob.statusCode !== 200)
    throw new ApiError(404, "CLI_RELEASE_NOT_FOUND", "This Vector CLI release is not available.")
  return readCliManifest(blob.stream, blob.blob.url, version)
}
