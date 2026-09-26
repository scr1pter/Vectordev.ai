import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, symlink } from "node:fs/promises"
import { create } from "tar"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliReleaseFixture } from "./cli-release-fixture"
import { hashCliFile, packageCliRelease } from "./cli-release-package"
import { prepareCliContainer } from "./cli-container"

for (const arch of ["amd64", "arm64"] as const)
  test(`prepares ${arch} musl image input from verified release bytes`, async () => {
    await using sample = await cliReleaseFixture()
    const manifest = await packageCliRelease(sample.input)
    const output = path.join(sample.root, "container")
    const result = await prepareCliContainer({ ...sample.input, archives: sample.input.output, output, arch })
    const target = arch === "amd64" ? "linux-x64-baseline-musl" : "linux-arm64-musl"
    expect(result.archiveSha256).toBe(manifest.targets[target].sha256)
    expect(
      Buffer.from(await Bun.file(path.join(output, "vector")).bytes()).equals(
        Buffer.from(await Bun.file(path.join(sample.input.source, `vector-${target}/bin/vector`)).bytes()),
      ),
    ).toBe(true)
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
      expect(await Bun.file(path.join(output, name)).text()).toBe(`Vector fixture notice: ${name}\n`)
    expect(await Bun.file(path.join(output, "Dockerfile")).text()).toContain("USER 10001:10001")
    expect(await Bun.file(path.join(output, "CONTAINER-INFO.json")).json()).toMatchObject({
      version: sample.input.version,
      platform: `linux/${arch}`,
      target,
    })
    await expect(
      prepareCliContainer({ ...sample.input, archives: sample.input.output, output, arch }),
    ).rejects.toThrow()
  })

test("rejects mismatched provenance and tampered archives before creating a build context", async () => {
  await using sample = await cliReleaseFixture()
  await packageCliRelease(sample.input)
  const input = {
    ...sample.input,
    archives: sample.input.output,
    output: path.join(sample.root, "container"),
    arch: "amd64" as const,
  }
  await expect(prepareCliContainer({ ...input, sourceRevision: "b".repeat(40) })).rejects.toThrow(
    "reviewed CLI release",
  )
  const file = path.join(sample.input.output, CliRelease.filename("linux-x64-baseline-musl"))
  const bytes = await Bun.file(file).bytes()
  bytes[bytes.length - 1] ^= 1
  await Bun.write(file, bytes)
  await expect(prepareCliContainer(input)).rejects.toThrow("checksum")
  expect(await Bun.file(path.join(input.output, "Dockerfile")).exists()).toBe(false)
})

test("rejects linked archive entries even when their archive hash is internally consistent", async () => {
  await using sample = await cliReleaseFixture()
  const manifest = await packageCliRelease(sample.input)
  const source = path.join(sample.root, "malformed")
  await mkdir(source)
  await symlink("/etc/passwd", path.join(source, "vector"))
  const target = "linux-x64-baseline-musl"
  const file = path.join(sample.input.output, manifest.targets[target].filename)
  await create({ cwd: source, file, gzip: true }, ["vector"])
  Object.assign(manifest.targets[target], await hashCliFile(file))
  await Bun.write(path.join(sample.input.output, "manifest.json"), JSON.stringify(manifest))
  await expect(
    prepareCliContainer({
      ...sample.input,
      archives: sample.input.output,
      output: path.join(sample.root, "container"),
      arch: "amd64",
    }),
  ).rejects.toThrow("unsafe")
})
