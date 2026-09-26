import path from "node:path"
import os from "node:os"
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import { extract, list } from "tar"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliNotices } from "./cli-release-package"

/** Consumes the same reviewed archives as standalone installers, never a registry's moving CLI tag. */
export async function prepareCliContainer(input: {
  archives: string
  output: string
  arch: "amd64" | "arm64"
  version: string
  sourceRevision: string
  catalogSha256: string
  origin: string
}) {
  if (input.arch !== "amd64" && input.arch !== "arm64") throw new Error("Unsupported container architecture")
  const manifest = CliRelease.decode(await Bun.file(path.join(input.archives, "manifest.json")).json(), input.origin)
  if (
    manifest.version !== input.version ||
    manifest.sourceRevision !== input.sourceRevision ||
    manifest.catalogSha256 !== input.catalogSha256
  )
    throw new Error("Container inputs do not match the reviewed CLI release")
  const target = input.arch === "amd64" ? "linux-x64-baseline-musl" : "linux-arm64-musl"
  const asset = manifest.targets[target]
  const source = path.join(input.archives, asset.filename)
  const stat = await lstat(source)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== asset.size || stat.size > CliRelease.MAX_ARCHIVE_BYTES)
    throw new Error("Container archive is not the expected regular file")
  const bytes = await Bun.file(source).bytes()
  if (bytes.byteLength !== asset.size || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("Container archive checksum mismatch")
  const temporary = await mkdtemp(path.join(os.tmpdir(), "vector-container-"))
  try {
    const archive = path.join(temporary, "verified.tar.gz")
    await Bun.write(archive, bytes)
    const entries: string[] = []
    const audit = { invalid: false }
    const expected: readonly string[] = ["vector", ...cliNotices]
    await list({
      file: archive,
      strict: true,
      onReadEntry: (entry) => {
        if (
          !expected.includes(entry.path) ||
          entries.includes(entry.path) ||
          entry.type !== "File" ||
          entry.size <= 0 ||
          entry.size > CliRelease.MAX_ARCHIVE_BYTES
        )
          audit.invalid = true
        if (entries.length < 5) entries.push(entry.path)
      },
    })
    if (audit.invalid) throw new Error("Container archive contains an unsafe or duplicate entry")
    if (entries.length !== expected.length) throw new Error("Container archive is missing its binary or notices")
    const unpacked = path.join(temporary, "unpacked")
    await mkdir(unpacked)
    await extract({ file: archive, cwd: unpacked, strict: true, preservePaths: false })
    const header = await Bun.file(path.join(unpacked, "vector")).slice(0, 64).bytes()
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (
      header.length < 64 ||
      view.getUint32(0, false) !== 0x7f454c46 ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      view.getUint16(18, true) !== (input.arch === "arm64" ? 183 : 62)
    )
      throw new Error("Container binary architecture does not match its target")
    // Refuse existing output so a failed attempt cannot mix new and stale release bytes.
    await mkdir(input.output)
    for (const file of expected) {
      await copyFile(path.join(unpacked, file), path.join(input.output, file))
      await chmod(path.join(input.output, file), file === "vector" ? 0o755 : 0o644)
    }
    await copyFile(new URL("../container/Dockerfile", import.meta.url), path.join(input.output, "Dockerfile"))
    await Bun.write(
      path.join(input.output, "CONTAINER-INFO.json"),
      JSON.stringify(
        {
          version: manifest.version,
          sourceRevision: manifest.sourceRevision,
          catalogSha256: manifest.catalogSha256,
          platform: `linux/${input.arch}`,
          target,
          archiveSha256: asset.sha256,
        },
        null,
        2,
      ) + "\n",
    )
    return { target, archiveSha256: asset.sha256 }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const arch = process.env.VECTOR_CONTAINER_ARCH
  if (arch !== "amd64" && arch !== "arm64") throw new Error("Choose amd64 or arm64 for the container")
  console.log(
    await prepareCliContainer({
      archives: process.env.VECTOR_CLI_RELEASE_DIR ?? "cli-release",
      output: process.env.VECTOR_CONTAINER_CONTEXT ?? "container-context",
      arch,
      version: process.env.VECTOR_RELEASE_VERSION ?? "",
      sourceRevision: process.env.VECTOR_SOURCE_REVISION ?? "",
      catalogSha256: process.env.VECTOR_CATALOG_SHA256 ?? "",
      origin: process.env.VECTOR_CLI_BLOB_ORIGIN ?? "",
    }),
  )
}
