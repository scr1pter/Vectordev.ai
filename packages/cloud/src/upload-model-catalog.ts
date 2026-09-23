import { list, put } from "@vercel/blob"
import { desktopReleaseVersion } from "./desktop-release-version"

const version = desktopReleaseVersion(process.env.VECTOR_RELEASE_VERSION)
const file = process.env.VECTOR_CATALOG_FILE
if (!file) throw new Error("VECTOR_CATALOG_FILE is required")
const data: unknown = await Bun.file(file).json()
if (
  !data ||
  typeof data !== "object" ||
  Array.isArray(data) ||
  !Object.keys(data).length ||
  Object.keys(data).some((id) => id.toLowerCase().startsWith("opencode"))
) {
  throw new Error("The release catalog is empty or contains a retired provider")
}
const pathname = `releases/vector-v${version}/api.json`
const token = process.env.BLOB_READ_WRITE_TOKEN
const body = JSON.stringify(data)
const existing = (await list({ prefix: pathname, token })).blobs.find((item) => item.pathname === pathname)
if (existing) {
  const response = await fetch(existing.url)
  if (!response.ok || (await response.text()) !== body)
    throw new Error("An immutable release catalog already exists with different content")
  console.log(`Verified existing release catalog: ${existing.url}`)
  process.exit(0)
}
const result = await put(pathname, body, {
  access: "public",
  addRandomSuffix: false,
  allowOverwrite: false,
  contentType: "application/json",
  token,
})
console.log(`Published release catalog: ${result.url}`)
