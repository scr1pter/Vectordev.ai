import { createHash } from "node:crypto"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { Schema } from "effect"

/** Desktop WSL support may ship only after its exact native CLI release is readable. */
export async function verifyRequiredCli(version: string, transport: typeof fetch = fetch) {
  Schema.decodeUnknownSync(CliRelease.Version)(version)
  const response = await transport(`https://vectordev.ai/api/cli-release?version=${version}`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Required Vector CLI ${version} is not published.`)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > CliRelease.MAX_MANIFEST_BYTES) throw new Error("Required CLI manifest exceeds its size limit.")
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const manifest = CliRelease.decode(
    Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(Buffer.concat(chunks).toString("utf8")),
  )
  if (manifest.version !== version) throw new Error("The required CLI manifest returned a different version.")
  // Every Linux libc/CPU choice the installer can make must be ready before desktop publication.
  for (const pair of [CliRelease.targets.slice(3, 5), CliRelease.targets.slice(5, 7), CliRelease.targets.slice(7, 9)])
    await Promise.all(pair.map((target) => verifyArchive(manifest.targets[target]!, transport)))
  return { version, targets: CliRelease.targets.filter((target) => target.startsWith("linux-")) }
}

async function verifyArchive(asset: CliRelease.Asset, transport: typeof fetch) {
  const response = await transport(asset.url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(`Required CLI archive is unavailable: ${asset.filename}`)
  }
  const digest = createHash("sha256")
  const reader = response.body.getReader()
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > asset.size) throw new Error(`Required CLI archive exceeds its declared size: ${asset.filename}`)
      digest.update(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (size !== asset.size || digest.digest("hex") !== asset.sha256)
    throw new Error(`Required CLI archive failed integrity verification: ${asset.filename}`)
}

if (import.meta.main) {
  const manifest: unknown = await Bun.file(new URL("../../desktop/package.json", import.meta.url)).json()
  const input = Schema.decodeUnknownSync(Schema.Struct({ vectorRequiredCliVersion: CliRelease.Version }))(manifest)
  const result = await verifyRequiredCli(input.vectorRequiredCliVersion)
  console.log(`Verified required Vector CLI ${result.version}: ${result.targets.join(", ")}`)
}
