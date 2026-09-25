import path from "path"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { filterProviderCatalog } from "@vectordevai/schema/provider-policy"
import { Schema } from "effect"
import { catalogFork } from "./catalog-fork"

export function catalogDigest(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex")
}

export function catalogBody(text: string, fresh = false) {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length)
    throw new Error("The release catalog must be a nonempty provider object")
  const shaped = ModelCatalog.normalizePackages(
    Schema.decodeUnknownSync(ModelCatalog.Catalog, { onExcessProperty: "preserve" })(value),
  )
  const catalog = filterProviderCatalog(shaped)
  const reviewed = fresh
    ? Object.fromEntries(
        Object.entries(catalog).flatMap(([id, provider]) => {
          if (!ModelCatalog.packageAllowed(provider.npm)) {
            console.warn(`Omitting catalog provider ${id}: SDK ${provider.npm} is not bundled`)
            return []
          }
          const models = Object.fromEntries(
            Object.entries(provider.models).filter(([modelID, model]) => {
              if (ModelCatalog.packageAllowed(model.provider?.npm)) return true
              console.warn(`Omitting catalog model ${id}/${modelID}: SDK ${model.provider?.npm} is not bundled`)
              return false
            }),
          )
          return [[id, { ...provider, models }]]
        }),
      )
    : shaped
  const result = JSON.stringify(ModelCatalog.decodeCatalog(reviewed))
  if (result === "{}") throw new Error("The release catalog has no permitted providers")
  return result
}

export function releaseCatalogURL(version: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Release catalog version must use MAJOR.MINOR.PATCH")
  return `https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-v${version}/api.json`
}

export async function freshCatalog(input?: Parameters<typeof catalogFork>[0]) {
  const fork = await catalogFork(input)
  const source = await fork.read("vector/api.json")
  const text = catalogBody(source, true)
  return {
    text,
    provenance: {
      repository: fork.repository,
      revision: fork.revision,
      path: "vector/api.json",
      sourceSha256: catalogDigest(source),
      sha256: catalogDigest(text),
    },
  }
}

export async function prepareReleaseCatalog(input: {
  version: string
  directory: string
  fresh?: boolean
  file?: string
  sha256?: string
  fork?: Parameters<typeof catalogFork>[0]
  request?: (input: string, init: RequestInit) => Promise<Response>
}) {
  if (input.file || input.sha256) {
    if (!input.file || !input.sha256)
      throw new Error(
        "A supplied release catalog requires both VECTOR_RELEASE_CATALOG_PATH and VECTOR_RELEASE_CATALOG_SHA256",
      )
    const file = path.resolve(input.file)
    const text = await Bun.file(file).text()
    if (catalogDigest(text) !== input.sha256)
      throw new Error("Release catalog digest does not match the prepared snapshot")
    if (catalogBody(text) !== text)
      throw new Error("The pinned release catalog must be prepared with Vector's catalog generator")
    console.log(`Using reviewed Vector release catalog ${file}; sha256=${input.sha256}`)
    return { file, sha256: input.sha256 }
  }
  const source = releaseCatalogURL(input.version)
  const request = input.request ?? fetch
  const response = await request(source, { redirect: "error", signal: AbortSignal.timeout(30_000) })
  if (!response.ok && response.status !== 404)
    throw new Error(`Release catalog mirror returned HTTP ${response.status}`)
  if (response.status === 404 && !input.fresh)
    throw new Error(
      "The immutable release catalog is missing. Prepare and review it with --fresh-catalog before building.",
    )
  const prepared = response.status === 404 ? await freshCatalog(input.fork) : undefined
  const body = prepared?.text ?? (await response.text())
  const text = catalogBody(body)
  if (text !== body)
    throw new Error("The immutable release catalog is not a prepared Vector snapshot; refusing to change its content")
  const file = path.join(input.directory, "api.json")
  const sha256 = catalogDigest(text)
  await Bun.write(file, text)
  await Bun.write(path.join(input.directory, "api.sha256"), `${sha256}  api.json\n`)
  if (prepared)
    await Bun.write(
      path.join(input.directory, "api.provenance.json"),
      JSON.stringify(prepared.provenance, null, 2) + "\n",
    )
  console.log(
    `Prepared Vector release catalog from ${prepared ? `${prepared.provenance.repository}@${prepared.provenance.revision}` : source}; sha256=${sha256}`,
  )
  return { file, sha256 }
}

export async function ensurePublishedCatalog(input: {
  version: string
  file: string
  upload: () => Promise<void>
  request?: (input: string, init: RequestInit) => Promise<Response>
}) {
  const response = await (input.request ?? fetch)(releaseCatalogURL(input.version), {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404) {
    await input.upload()
    return
  }
  if (!response.ok) throw new Error(`Release catalog mirror returned HTTP ${response.status}; publication stopped`)
  if ((await response.text()) !== (await Bun.file(input.file).text()))
    throw new Error("The immutable release catalog differs from this CLI build; publication stopped")
}
