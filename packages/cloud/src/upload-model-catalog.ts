import { list, put } from "@vercel/blob"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { providerAllowed } from "@vectordevai/schema/provider-policy"
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
  const decoded = ModelCatalog.decodeCatalog(catalog)
  const body = JSON.stringify(data)
  // Publishing must use the same reviewed snapshot that was embedded in the binaries.
  if (JSON.stringify(decoded) !== body) {
    throw new Error("The release catalog must be prepared with Vector's catalog generator")
  }
  return body
}

export function releaseCatalogText(text: string) {
  const body = releaseCatalogBody(JSON.parse(text))
  if (text !== body) throw new Error("The release catalog must preserve the exact prepared bytes")
  return body
}

export async function publishCatalog(input: {
  version: string
  text: string
  updateMirror?: boolean
  find: (pathname: string) => Promise<{ url: string } | undefined>
  write: (pathname: string, body: string, mutable: boolean) => Promise<{ url: string }>
  request?: (input: string, init: RequestInit) => Promise<Response>
}) {
  const body = releaseCatalogText(input.text)
  const pathname = `releases/vector-v${desktopReleaseVersion(input.version)}/api.json`
  const existing = await input.find(pathname)
  if (existing) {
    const response = await (input.request ?? fetch)(existing.url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok || (await response.text()) !== body)
      throw new Error("An immutable release catalog already exists with different content")
    console.log(`Verified existing release catalog: ${existing.url}`)
  }
  const release = existing ?? (await input.write(pathname, body, false))
  // Updating the shared mirror is explicit so a retry of an older release cannot move it backwards.
  const mirror = input.updateMirror ? await input.write("models/api.json", body, true) : undefined
  return { release, mirror }
}

if (import.meta.main) {
  const file = process.env.VECTOR_CATALOG_FILE
  if (!file) throw new Error("VECTOR_CATALOG_FILE is required")
  const token = process.env.BLOB_READ_WRITE_TOKEN
  const result = await publishCatalog({
    version: desktopReleaseVersion(process.env.VECTOR_RELEASE_VERSION),
    text: await Bun.file(file).text(),
    updateMirror: process.argv.includes("--update-mirror"),
    find: async (pathname) =>
      (await list({ prefix: pathname, token })).blobs.find((item) => item.pathname === pathname),
    write: (pathname, body, mutable) =>
      put(pathname, body, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: mutable,
        contentType: "application/json",
        cacheControlMaxAge: mutable ? 60 : 31_536_000,
        token,
      }),
  })
  console.log(`Release catalog: ${result.release.url}`)
  if (result.mirror) console.log(`Updated Vector catalog mirror: ${result.mirror.url}`)
}
