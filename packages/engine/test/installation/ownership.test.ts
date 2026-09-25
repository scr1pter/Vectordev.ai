import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationOwnership } from "../../src/installation/ownership"
import { Standalone } from "../../src/installation/standalone"

async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-ownership-"))
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
const noCommand: Standalone.Run = async () => ({ code: 1, stdout: "", stderr: "" })

test("standalone ownership requires the exact current binary hash and uninstalls only owned files", async () => {
  await using fixture = await directory()
  const executable = path.join(fixture.root, "vector")
  const metadata = path.join(fixture.root, ".vector-vector")
  await mkdir(metadata)
  await Bun.write(executable, "synthetic executable")
  const hash = createHash("sha256").update("synthetic executable").digest("hex")
  await Bun.write(
    path.join(metadata, "receipt.tsv"),
    `vector-standalone\t1\t1.2.3\tlinux-x64-baseline\tlatest\tvector\t${hash}\t${"a".repeat(64)}\n`,
  )
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await Bun.write(path.join(metadata, name), name)
  const owned = await Standalone.receipt(executable)
  expect(owned?.version).toBe("1.2.3")
  expect((await InstallationOwnership.detect(noCommand, executable)).method).toBe("standalone")
  await Bun.write(executable, "unrelated replacement")
  expect(await Standalone.receipt(executable)).toBeUndefined()
  await Bun.write(executable, "synthetic executable")
  await Bun.write(path.join(metadata, "keep-user-file"), "user data")
  expect(await Standalone.uninstall(owned!, noCommand)).toEqual({ status: "complete" })
  expect(await Bun.file(executable).exists()).toBe(false)
  expect(await Bun.file(path.join(metadata, "receipt.tsv")).exists()).toBe(false)
  expect(await Bun.file(path.join(metadata, "keep-user-file")).text()).toBe("user data")
})

test("global package listings cannot claim an unrelated running executable", async () => {
  await using fixture = await directory()
  const executable = path.join(fixture.root, "vector")
  await Bun.write(executable, "unrelated")
  const calls: string[][] = []
  const detected = await InstallationOwnership.detect(async (command) => {
    calls.push(command)
    return { code: 0, stdout: "@vectordevai/cli@1.2.3", stderr: "" }
  }, executable)
  expect(detected).toEqual({ method: "unknown" })
  expect(calls.every((command) => !command.includes("list"))).toBe(true)
})

test("npm ownership resolves the current native dependency from the actual global CLI package", async () => {
  await using fixture = await directory()
  const root = path.join(fixture.root, "node_modules")
  await Bun.write(path.join(root, "@vectordevai/cli/package.json"), JSON.stringify({ name: "@vectordevai/cli" }))
  await Bun.write(
    path.join(root, "@vectordevai/cli-linux-x64/package.json"),
    JSON.stringify({ name: "@vectordevai/cli-linux-x64" }),
  )
  const executable = path.join(root, "@vectordevai/cli-linux-x64/bin/vector")
  await Bun.write(executable, "native")
  expect(
    await InstallationOwnership.detect(
      async (command) => ({ code: command[0] === "npm" ? 0 : 1, stdout: root, stderr: "" }),
      executable,
    ),
  ).toEqual({ method: "npm", package: "@vectordevai/cli" })
  const other = path.join(fixture.root, "other/vector")
  await Bun.write(other, "other")
  expect((await InstallationOwnership.detect(async () => ({ code: 0, stdout: root, stderr: "" }), other)).method).toBe(
    "unknown",
  )
})

test("Bun ownership follows its actual global launcher and native dependency", async () => {
  await using fixture = await directory()
  const root = path.join(fixture.root, "node_modules")
  await Bun.write(path.join(root, "@vectordevai/cli/package.json"), JSON.stringify({ name: "@vectordevai/cli" }))
  await Bun.write(path.join(root, "@vectordevai/cli/bin/vector.cjs"), "launcher")
  await Bun.write(
    path.join(root, "@vectordevai/cli-linux-x64/package.json"),
    JSON.stringify({ name: "@vectordevai/cli-linux-x64" }),
  )
  const executable = path.join(root, "@vectordevai/cli-linux-x64/bin/vector")
  await Bun.write(executable, "native")
  const bin = path.join(fixture.root, "bin")
  await mkdir(bin)
  await symlink(path.join(root, "@vectordevai/cli/bin/vector.cjs"), path.join(bin, "vector"))
  expect(
    await InstallationOwnership.detect(
      async (command) => ({ code: command[0] === "bun" ? 0 : 1, stdout: bin, stderr: "" }),
      executable,
    ),
  ).toEqual({ method: "bun", package: "@vectordevai/cli" })
})

test("Homebrew and Scoop use recorded manager identities rather than invented repositories", async () => {
  await using fixture = await directory()
  const prefix = path.join(fixture.root, "Cellar/vector/1.2.3")
  const executable = path.join(prefix, "bin/vector")
  await Bun.write(executable, "native")
  const brew = await InstallationOwnership.detect(
    async (command) => ({
      code: 0,
      stdout:
        command[1] === "--prefix"
          ? prefix
          : JSON.stringify({
              formulae: [
                {
                  name: "vector",
                  full_name: "fixture-owner/fixture-tap/vector",
                  homepage: "https://vectordev.ai",
                  versions: { stable: "1.2.4" },
                },
              ],
            }),
      stderr: "",
    }),
    executable,
  )
  expect(brew).toEqual({ method: "homebrew", package: "fixture-owner/fixture-tap/vector", latest: "1.2.4" })
  const scoop = path.join(fixture.root, "apps/vector/1.2.3")
  await Bun.write(path.join(scoop, "vector.exe"), "native")
  await Bun.write(path.join(scoop, "install.json"), JSON.stringify({ bucket: "fixture-bucket" }))
  await Bun.write(
    path.join(scoop, "manifest.json"),
    JSON.stringify({ version: "1.2.3", homepage: "https://vectordev.ai" }),
  )
  expect(
    await InstallationOwnership.detect(
      async () => ({
        code: 0,
        stdout: JSON.stringify({ version: "1.2.4", homepage: "https://vectordev.ai" }),
        stderr: "",
      }),
      path.join(scoop, "vector.exe"),
    ),
  ).toEqual({ method: "scoop", package: "fixture-bucket/vector", latest: "1.2.4" })
})
