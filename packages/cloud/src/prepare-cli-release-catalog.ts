import path from "node:path"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliBlobUrl } from "./cli-release-package"
import { releaseCatalogText } from "./upload-model-catalog"

// This release entrypoint consumes an already reviewed, immutable catalog.
// It cannot generate a fresh catalog or silently select current model data.
export function cliReleaseInputs(env: Record<string, string | undefined>) {
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`${name} is required.`)
    return value
  }
  const version = required("VECTOR_RELEASE_VERSION")
  const channel = required("VECTOR_RELEASE_CHANNEL")
  const origin = required("VECTOR_CLI_BLOB_ORIGIN")
  const sourceRevision = required("VECTOR_SOURCE_REVISION")
  const catalogSha256 = required("VECTOR_CATALOG_SHA256")
  const publishedAt = required("VECTOR_RELEASE_PUBLISHED_AT")
  CliRelease.decode(
    {
      schemaVersion: 1,
      version,
      channel,
      sourceRevision,
      catalogSha256,
      publishedAt,
      targets: Object.fromEntries(
        CliRelease.targets.map((target) => [
          target,
          {
            filename: CliRelease.filename(target),
            pathname: CliRelease.archivePath(version, target),
            url: cliBlobUrl(origin, CliRelease.archivePath(version, target)),
            size: 1,
            sha256: "0".repeat(64),
          },
        ]),
      ),
    },
    origin,
  )
  return { version, channel, origin, sourceRevision, catalogSha256, publishedAt }
}

export async function prepareCliReleaseCatalog(input: {
  release: ReturnType<typeof cliReleaseInputs>
  output: string
  request?: (url: string, init: RequestInit) => Promise<Response>
}) {
  const response = await (input.request ?? fetch)(
    cliBlobUrl(input.release.origin, `releases/vector-v${input.release.version}/api.json`),
    {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    },
  )
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error("Publish the reviewed immutable release catalog before building standalone CLI archives.")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 32_000_000) throw new Error("The release catalog exceeds the size limit.")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const body = Buffer.concat(chunks)
  if (new Bun.CryptoHasher("sha256").update(body).digest("hex") !== input.release.catalogSha256)
    throw new Error("The immutable release catalog differs from the pinned SHA-256.")
  releaseCatalogText(body.toString("utf8"))
  await Bun.write(input.output, body)
}

if (import.meta.main) {
  const release = cliReleaseInputs(process.env)
  if (!process.argv.includes("--validate")) {
    await prepareCliReleaseCatalog({ release, output: path.resolve("cli-release-catalog/api.json") })
    console.log(`Prepared the pinned catalog for Vector CLI ${release.version}`)
  }
}
