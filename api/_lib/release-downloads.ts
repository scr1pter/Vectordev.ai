import { get } from "@vercel/blob"
import { ApiError } from "./http.js"
import {
  DOWNLOAD_MANIFEST_PATH,
  installerFromManifest,
  installerFor,
  parseDownloadManifestJson,
  type DownloadManifest,
} from "./downloads.js"

export async function currentDownloadManifest(): Promise<DownloadManifest> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim()
  if (!token) throw new ApiError(503, "DOWNLOADS_NOT_CONFIGURED", "Vector downloads are not configured yet.")
  const blob = await get(DOWNLOAD_MANIFEST_PATH, {
    access: "public",
    token,
    useCache: false,
  })
  if (!blob || blob.statusCode !== 200) {
    throw new ApiError(503, "DOWNLOAD_MANIFEST_MISSING", "Vector's latest release is not available yet.")
  }
  const manifest = parseDownloadManifestJson(await new Response(blob.stream).text(), new URL(blob.blob.url).origin)
  return manifest
}

export async function currentInstaller(target: string | undefined) {
  installerFor(target)
  const manifest = await currentDownloadManifest()
  return { manifest, installer: installerFromManifest(manifest, target) }
}
