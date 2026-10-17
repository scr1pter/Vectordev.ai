import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.join(import.meta.dir, "finalize-latest-yml.ts")

const feed = (version: string, arch: string, sha: string) => `version: ${version}
files:
  - url: vector-desktop-${version}-mac-${arch}.zip
    sha512: ${sha}zip==
    size: 183418017
    blockMapSize: 190123
  - url: vector-desktop-${version}-mac-${arch}.dmg
    sha512: ${sha}dmg==
    size: 185051292
path: vector-desktop-${version}-mac-${arch}.zip
sha512: ${sha}zip==
releaseDate: '2026-10-17T18:00:00.000Z'
`

// Runs the real script with a gh on PATH that records any call, so a read-only release job would fail if it ran one.
async function finalize(versions: { arm64: string; x64: string }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-latest-yml-"))
  const feeds = path.join(directory, "feeds")
  const output = path.join(directory, "out")
  const bin = path.join(directory, "bin")
  await Promise.all([output, bin].map((item) => mkdir(item, { recursive: true })))
  await Bun.write(path.join(feeds, "latest-yml-aarch64-apple-darwin", "latest-mac.yml"), feed(versions.arm64, "arm64", "ARM"))
  await Bun.write(path.join(feeds, "latest-yml-x86_64-apple-darwin", "latest-mac.yml"), feed(versions.x64, "x64", "X64"))
  await Bun.write(path.join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${path.join(directory, "gh-calls")}"\nexit 1\n`)
  await chmod(path.join(bin, "gh"), 0o755)
  const child = Bun.spawn([process.execPath, script], {
    env: { PATH: bin, LATEST_YML_DIR: feeds, RUNNER_TEMP: output, VECTOR_VERSION: "1.99.108" },
    stdout: "ignore",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  const merged = Bun.file(path.join(output, "latest-mac.yml"))
  const result = {
    code,
    stderr,
    merged: (await merged.exists()) ? await merged.text() : undefined,
    gh: await Bun.file(path.join(directory, "gh-calls")).exists(),
  }
  await rm(directory, { recursive: true, force: true })
  return result
}

test("merges both Mac architectures into one feed without touching the GitHub release", async () => {
  const result = await finalize({ arm64: "1.99.108", x64: "1.99.108" })
  expect(result.code).toBe(0)
  expect(result.gh).toBe(false)
  expect(result.merged).toBe(`version: 1.99.108
files:
  - url: vector-desktop-1.99.108-mac-arm64.zip
    sha512: ARMzip==
    size: 183418017
    blockMapSize: 190123
  - url: vector-desktop-1.99.108-mac-arm64.dmg
    sha512: ARMdmg==
    size: 185051292
  - url: vector-desktop-1.99.108-mac-x64.zip
    sha512: X64zip==
    size: 183418017
    blockMapSize: 190123
  - url: vector-desktop-1.99.108-mac-x64.dmg
    sha512: X64dmg==
    size: 185051292
releaseDate: '2026-10-17T18:00:00.000Z'
`)
})

test("refuses a merged feed for another version", async () => {
  const result = await finalize({ arm64: "1.99.107", x64: "1.99.107" })
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("is for 1.99.107, not 1.99.108")
  expect(result.merged).toBeUndefined()
})
