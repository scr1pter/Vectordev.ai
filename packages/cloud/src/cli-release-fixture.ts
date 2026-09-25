import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { cliNotices } from "./cli-release-package"

export async function cliReleaseFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-cli-release-test-"))
  const source = path.join(root, "dist")
  await mkdir(source)
  const catalog = JSON.stringify(
    ModelCatalog.decodeCatalog({ openai: { id: "openai", name: "OpenAI", env: [], models: {} } }),
  )
  const input = {
    source,
    output: path.join(root, "archives"),
    version: "1.99.123",
    channel: "latest" as const,
    sourceRevision: "a".repeat(40),
    catalogSha256: new Bun.CryptoHasher("sha256").update(catalog).digest("hex"),
    origin: "https://fixturestore.public.blob.vercel-storage.com",
    publishedAt: "2026-09-25T00:00:00.000Z",
  }
  await Bun.write(path.join(source, "api.json"), catalog)
  for (const target of CliRelease.targets) {
    const directory = path.join(source, `vector-${target}`)
    await mkdir(path.join(directory, "bin"), { recursive: true })
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: `vector-${target}`,
        version: input.version,
        vectorStandalone: true,
        vectorSourceRevision: input.sourceRevision,
        vectorCatalogSha256: input.catalogSha256,
      }),
    )
    const bytes = new Uint8Array(256)
    const view = new DataView(bytes.buffer)
    const arm = target.includes("-arm64")
    if (target.startsWith("darwin-")) {
      view.setUint32(0, 0xfeedfacf, true)
      view.setUint32(4, arm ? 0x100000c : 0x1000007, true)
    } else if (target.startsWith("linux-")) {
      view.setUint32(0, 0x7f454c46, false)
      bytes[4] = 2
      bytes[5] = 1
      view.setUint16(18, arm ? 183 : 62, true)
    } else {
      view.setUint16(0, 0x5a4d, true)
      view.setUint32(60, 128, true)
      view.setUint32(128, 0x4550, true)
      view.setUint16(132, arm ? 0xaa64 : 0x8664, true)
    }
    bytes.set(new TextEncoder().encode(target), 160)
    await Bun.write(path.join(directory, "bin", target.startsWith("windows-") ? "vector.exe" : "vector"), bytes)
    for (const name of cliNotices) await Bun.write(path.join(directory, name), `Vector fixture notice: ${name}\n`)
  }
  return { root, input, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) }
}
