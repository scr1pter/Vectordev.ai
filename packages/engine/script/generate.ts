import path from "path"
import { catalogBody, catalogDigest } from "./release-catalog"

const input = process.env.VECTOR_RELEASE_CATALOG_PATH
const supplied = input ? path.resolve(input) : undefined
const output = process.env.VECTOR_CATALOG_FILE ? path.resolve(process.env.VECTOR_CATALOG_FILE) : undefined
const expected = process.env.VECTOR_RELEASE_CATALOG_SHA256
const fresh = import.meta.main && process.argv.includes("--fresh-catalog")
if (!supplied && !fresh)
  throw new Error(
    "A pinned release catalog requires VECTOR_RELEASE_CATALOG_PATH and VECTOR_RELEASE_CATALOG_SHA256; prepare one explicitly with --fresh-catalog",
  )
if (supplied && !expected) throw new Error("VECTOR_RELEASE_CATALOG_SHA256 is required for a supplied release catalog")
if (expected && !supplied) throw new Error("A pinned release catalog requires VECTOR_RELEASE_CATALOG_PATH")

// Only an explicit preparation command can refresh the external catalog.
const source = supplied ?? "https://models.dev/api.json"
const response = supplied ? undefined : await fetch(source, { redirect: "error", signal: AbortSignal.timeout(30_000) })
if (response && !response.ok) throw new Error(`Catalog source returned HTTP ${response.status}`)
const text = supplied ? await Bun.file(supplied).text() : await response!.text()
const digest = catalogDigest(text)
if (expected && digest !== expected) throw new Error("Release catalog digest does not match the prepared snapshot")
export const modelsData = catalogBody(text, fresh)
if (supplied && !fresh && modelsData !== text)
  throw new Error(
    "The pinned release catalog is not prepared; run explicit --fresh-catalog preparation and review its output",
  )
export const modelsSha256 = catalogDigest(modelsData)
if (output) await Bun.write(output, modelsData)
console.log(`Loaded Vector release catalog from ${source}; source sha256=${digest}; embedded sha256=${modelsSha256}`)
