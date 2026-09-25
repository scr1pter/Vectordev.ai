import path from "path"
import { catalogBody, catalogDigest, freshCatalog } from "./release-catalog"

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
if (fresh && supplied)
  throw new Error(
    "Fresh catalogs must come from the pinned Vector fork, not a supplied JSON file; omit VECTOR_RELEASE_CATALOG_PATH",
  )

// A fresh preparation reads reviewed Git objects in the owner's data fork, without network or code execution.
const prepared = supplied ? undefined : await freshCatalog()
const source = supplied ?? `${prepared!.provenance.repository}@${prepared!.provenance.revision}`
const text = supplied ? await Bun.file(supplied).text() : prepared!.text
const digest = catalogDigest(text)
if (expected && digest !== expected) throw new Error("Release catalog digest does not match the prepared snapshot")
export const modelsData = catalogBody(text, fresh)
if (supplied && !fresh && modelsData !== text)
  throw new Error(
    "The pinned release catalog is not prepared; run explicit --fresh-catalog preparation and review its output",
  )
export const modelsSha256 = catalogDigest(modelsData)
if (output) await Bun.write(output, modelsData)
if (output && prepared)
  await Bun.write(`${output}.provenance.json`, JSON.stringify(prepared.provenance, null, 2) + "\n")
console.log(`Loaded Vector release catalog from ${source}; source sha256=${digest}; embedded sha256=${modelsSha256}`)
