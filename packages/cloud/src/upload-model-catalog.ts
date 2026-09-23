import { list, put } from "@vercel/blob"
import { filterProviderCatalog, providerAllowed } from "@vectordevai/schema/provider-policy"
import { desktopReleaseVersion } from "./desktop-release-version"

export function releaseCatalogBody(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) {
    throw new Error("The release catalog must be a nonempty provider object")
  }
  const catalog = Object.fromEntries(
    Object.entries(data).map(([id, provider]) => {
      if (
        !providerAllowed(id) ||
        !provider ||
        typeof provider !== "object" ||
        Array.isArray(provider) ||
        !("id" in provider) ||
        provider.id !== id
      ) {
        throw new Error(`The release catalog contains an unsupported or inconsistent provider: ${id}`)
      }
      return [id, { ...provider, id }]
    }),
  )
  const body = JSON.stringify(data)
  // Publishing must use the same reviewed snapshot that was embedded in the binaries.
  if (JSON.stringify(filterProviderCatalog(catalog)) !== body) {
    throw new Error("The release catalog must be prepared with Vector's catalog generator")
  }
  return body
}

if (import.meta.main) {
  const version = desktopReleaseVersion(process.env.VECTOR_RELEASE_VERSION)
  const file = process.env.VECTOR_CATALOG_FILE
  if (!file) throw new Error("VECTOR_CATALOG_FILE is required")
  const body = releaseCatalogBody(await Bun.file(file).json())
  const pathname = `releases/vector-v${version}/api.json`
  const token = process.env.BLOB_READ_WRITE_TOKEN
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
}
