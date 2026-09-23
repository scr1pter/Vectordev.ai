import path from "path"
import { fileURLToPath } from "url"
import { providerAllowed, providerEndpointAllowed } from "@opencode-ai/core/provider-policy"

const dir = fileURLToPath(new URL("..", import.meta.url))
const input = process.env.VECTOR_MODELS_PATH ?? process.env.OPENCODE_MODELS_PATH ?? process.env.MODELS_DEV_API_JSON
const supplied = input ? path.resolve(input) : undefined
const output = process.env.VECTOR_CATALOG_FILE ? path.resolve(process.env.VECTOR_CATALOG_FILE) : undefined
const expected = process.env.VECTOR_MODELS_SHA256

process.chdir(dir)

// Build-time catalog input only. Shipped runtimes never contact this source by default.
const modelsUrl =
  process.env.VECTOR_MODELS_BUILD_URL ??
  process.env.VECTOR_MODELS_URL ??
  process.env.OPENCODE_MODELS_URL ??
  "https://models.dev"
if (expected && !supplied) throw new Error("A pinned release catalog requires VECTOR_MODELS_PATH")
const response = supplied ? undefined : await fetch(`${modelsUrl.replace(/\/$/, "")}/api.json`)
if (response && !response.ok) throw new Error(`Catalog source returned HTTP ${response.status}`)
const text = supplied ? await Bun.file(supplied).text() : await response!.text()
if (expected && new Bun.CryptoHasher("sha256").update(text).digest("hex") !== expected) {
  throw new Error("Release catalog digest does not match the prepared snapshot")
}
const catalog = JSON.parse(text) as Record<string, { api?: string }>
if (!catalog || typeof catalog !== "object" || Array.isArray(catalog) || !Object.keys(catalog).length) {
  throw new Error("The release catalog must be a nonempty provider object")
}
export const modelsData = JSON.stringify(
  Object.fromEntries(
    Object.entries(catalog).filter(([id, provider]) => providerAllowed(id) && providerEndpointAllowed(provider.api)),
  ),
)
if (modelsData === "{}") throw new Error("The release catalog has no permitted providers")
if (output) await Bun.write(output, modelsData)
console.log("Loaded Vector release catalog snapshot")
