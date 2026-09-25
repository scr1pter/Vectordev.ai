import { expect, test } from "bun:test"
import path from "node:path"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliPackageManagers } from "./cli-package-managers"
import { cliReleaseFixture } from "./cli-release-fixture"
import { packageCliRelease } from "./cli-release-package"

test("generates pinned baseline/ARM manager definitions and actual owner-supplied coordinates", async () => {
  await using fixture = await cliReleaseFixture()
  const manifest = await packageCliRelease(fixture.input)
  const result = cliPackageManagers({
    manifest,
    tapRepository: "fixture-owner/homebrew-code",
    scoopRepository: "fixture-owner/windows-bucket",
    scoopBucket: "fixture-vector",
  })
  const formula = path.join(fixture.root, "vector.rb")
  await Bun.write(formula, result.formula)
  const ruby = Bun.spawn(["ruby", "-c", formula], { stdout: "pipe", stderr: "pipe" })
  expect(await new Response(ruby.stdout).text()).toContain("Syntax OK")
  expect(await ruby.exited).toBe(0)
  for (const target of ["darwin-arm64", "darwin-x64-baseline", "linux-arm64", "linux-x64-baseline"] as const) {
    expect(result.formula).toContain(`url "${manifest.targets[target]!.url}"`)
    expect(result.formula).toContain(`sha256 "${manifest.targets[target]!.sha256}"`)
  }
  expect(result.formula).toContain('bin.install "vector"')
  expect(result.formula).toContain('"LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"')
  expect(result.formula).toContain("license :cannot_represent")
  const scoop = JSON.parse(result.scoop)
  expect(Object.keys(scoop.architecture)).toEqual(["64bit", "arm64"])
  for (const [arch, target] of [
    ["64bit", "windows-x64-baseline"],
    ["arm64", "windows-arm64"],
  ] as const)
    expect(scoop.architecture[arch]).toEqual({
      url: manifest.targets[target]!.url,
      hash: manifest.targets[target]!.sha256,
    })
  expect(scoop.bin).toBe("vector.exe")
  expect(scoop).not.toHaveProperty("installer")
  expect(scoop).not.toHaveProperty("autoupdate")
  expect(result.readme).toContain("brew install fixture-owner/code/vector")
  expect(result.readme).toContain("scoop bucket add fixture-vector https://github.com/fixture-owner/windows-bucket")
  expect(result.readme).toContain("scoop install fixture-vector/vector")
  expect(result.formula + result.scoop).not.toContain("latest.json")
})

test("requires actual explicit repository coordinates and refuses code/shell injection or beta input", async () => {
  await using fixture = await cliReleaseFixture()
  const manifest = await packageCliRelease(fixture.input)
  const valid = {
    manifest,
    tapRepository: "fixture-owner/homebrew-code",
    scoopRepository: "fixture-owner/windows-bucket",
    scoopBucket: "fixture-vector",
  }
  for (const tapRepository of [
    "",
    "owner/repo",
    "owner/homebrew-thing;rm",
    "https://github.com/owner/homebrew-thing",
    "owner/homebrew-a.git",
  ])
    expect(() => cliPackageManagers({ ...valid, tapRepository })).toThrow()
  for (const scoopRepository of ["", "owner/repo;run", "owner/repo\ncommand", "../repo"])
    expect(() => cliPackageManagers({ ...valid, scoopRepository })).toThrow()
  for (const scoopBucket of ["", "a b", "a;run", "$(run)"])
    expect(() => cliPackageManagers({ ...valid, scoopBucket })).toThrow()
  expect(() => cliPackageManagers({ ...valid, manifest: CliRelease.decode({ ...manifest, channel: "beta" }) })).toThrow(
    "stable",
  )
})
