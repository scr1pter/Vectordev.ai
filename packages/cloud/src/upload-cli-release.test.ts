import { expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliReleaseFixture } from "./cli-release-fixture"
import { hashCliFile, packageCliRelease } from "./cli-release-package"
import { commitCliRelease, stageCliRelease, verifyStagedCliRelease, type CliReleaseStore } from "./upload-cli-release"

async function fixture() {
  const local = await cliReleaseFixture()
  const manifest = await packageCliRelease(local.input)
  const objects = new Map<string, Uint8Array>()
  const writes: Array<{ pathname: string; mutable: boolean }> = []
  const reads: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname.slice(1)
      reads.push(pathname)
      const bytes = objects.get(pathname)
      return bytes ? new Response(bytes) : new Response(null, { status: 404 })
    },
  })
  const store: CliReleaseStore = {
    origin: local.input.origin,
    find: async (pathname) => (objects.has(pathname) ? { url: `${local.input.origin}/${pathname}` } : undefined),
    write: async (pathname, body, mutable) => {
      if (!mutable && objects.has(pathname)) throw new Error("Already exists")
      writes.push({ pathname, mutable })
      objects.set(pathname, typeof body === "string" ? new TextEncoder().encode(body) : await body.bytes())
      return { url: `${local.input.origin}/${pathname}` }
    },
    request: (url, init) => fetch(new URL(new URL(url).pathname, server.url), init),
  }
  return {
    manifest,
    store,
    objects,
    writes,
    reads,
    stage: () => stageCliRelease({ directory: local.input.output, manifest, store }),
    local,
    async [Symbol.asyncDispose]() {
      await server.stop(true)
      await local[Symbol.asyncDispose]()
    },
  }
}

test("stages immutable complete bytes, reuses verified objects, and commits the pointer only after every target read", async () => {
  await using f = await fixture()
  await f.stage()
  expect(f.writes).toHaveLength(13)
  expect(f.writes.every((entry) => !entry.mutable)).toBe(true)
  expect(f.writes.at(-1)?.pathname).toBe(CliRelease.manifestPath(f.manifest.version))
  await f.stage()
  await stageCliRelease({
    directory: f.local.input.output,
    manifest: { ...f.manifest, publishedAt: "2026-09-26T00:00:00.000Z" },
    store: f.store,
  })
  expect(f.writes).toHaveLength(13)
  expect((await verifyStagedCliRelease({ identity: f.manifest, store: f.store })).manifest).toEqual(f.manifest)
  f.reads.length = 0
  expect(await commitCliRelease({ identity: f.manifest, store: f.store })).toEqual(f.manifest)
  expect(f.reads).toEqual([
    CliRelease.manifestPath(f.manifest.version),
    ...CliRelease.targets.map((target) => f.manifest.targets[target]!.pathname),
  ])
  expect(f.writes.at(-1)).toEqual({ pathname: CliRelease.manifestPath("latest"), mutable: true })
  expect(JSON.parse(new TextDecoder().decode(f.objects.get(CliRelease.manifestPath("latest"))))).toEqual(f.manifest)
})

test("a missing final local target prevents every upload", async () => {
  await using f = await fixture()
  await rm(path.join(f.local.input.output, f.manifest.targets[CliRelease.targets.at(-1)!]!.filename))
  await expect(f.stage()).rejects.toThrow()
  expect(f.writes).toEqual([])
})

test("a prepared archive that fails the byte audit prevents every upload", async () => {
  await using f = await fixture()
  // Derived from the required MIT notice, as the audit itself does; never written here.
  const name = (await Bun.file(path.resolve(import.meta.dir, "../../../THIRD_PARTY_NOTICES.md")).text())
    .split("<!-- vector-upstream-attribution -->")[1]
    ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
    ?.trim() as string
  const target = CliRelease.targets.find((item) => item.startsWith("linux-"))!
  const archive = path.join(f.local.input.output, f.manifest.targets[target]!.filename)
  // A consistent manifest, so only the audit can stop this archive.
  await Bun.write(archive, Bun.gzipSync(new TextEncoder().encode(`vector\0${name} agent\0`)))
  const manifest = {
    ...f.manifest,
    targets: { ...f.manifest.targets, [target]: { ...f.manifest.targets[target]!, ...(await hashCliFile(archive)) } },
  }
  await expect(stageCliRelease({ directory: f.local.input.output, manifest, store: f.store })).rejects.toThrow(
    "artifact audit violation",
  )
  expect(f.writes).toEqual([])
})

test.each(["changed", "truncated", "oversized", "missing"])(
  "remote %s bytes cannot advance the channel",
  async (mode) => {
    await using f = await fixture()
    await f.stage()
    const target = f.manifest.targets["windows-arm64"]!
    const bytes = f.objects.get(target.pathname)!
    if (mode === "changed")
      f.objects.set(
        target.pathname,
        bytes.map((value) => value ^ 1),
      )
    if (mode === "truncated") f.objects.set(target.pathname, bytes.slice(0, -1))
    if (mode === "oversized") f.objects.set(target.pathname, new Uint8Array(bytes.length + 1))
    if (mode === "missing") f.objects.delete(target.pathname)
    await expect(commitCliRelease({ identity: f.manifest, store: f.store })).rejects.toThrow()
    expect(f.writes.every((entry) => !entry.mutable)).toBe(true)
    expect(f.objects.has(CliRelease.manifestPath("latest"))).toBe(false)
  },
)

test("different immutable content and wrong requested build identities cannot be reconciled", async () => {
  await using f = await fixture()
  await f.stage()
  const pathname = CliRelease.manifestPath(f.manifest.version)
  f.objects.set(pathname, new TextEncoder().encode(JSON.stringify({ ...f.manifest, catalogSha256: "0".repeat(64) })))
  await expect(f.stage()).rejects.toThrow("different release content")
  await expect(commitCliRelease({ identity: f.manifest, store: f.store })).rejects.toThrow("different catalogSha256")
  expect(f.writes).toHaveLength(13)
})

test("oversized manifests and other Blob tenants are rejected before channel mutation", async () => {
  await using f = await fixture()
  await f.stage()
  const pathname = CliRelease.manifestPath(f.manifest.version)
  f.objects.set(pathname, new Uint8Array(CliRelease.MAX_MANIFEST_BYTES + 1))
  await expect(commitCliRelease({ identity: f.manifest, store: f.store })).rejects.toThrow("exceeds the size limit")
  await expect(
    verifyStagedCliRelease({
      identity: f.manifest,
      store: { ...f.store, find: async () => ({ url: `https://another.public.blob.vercel-storage.com/${pathname}` }) },
    }),
  ).rejects.toThrow("different Blob")
  expect(f.writes).toHaveLength(13)
})

test("a raced immutable write is accepted only after its bytes are verified", async () => {
  await using f = await fixture()
  await stageCliRelease({
    directory: f.local.input.output,
    manifest: f.manifest,
    store: {
      ...f.store,
      write: async (pathname, body, mutable) => {
        await f.store.write(pathname, body, mutable)
        throw new Error("Uncertain write response")
      },
    },
  })
  expect(f.writes).toHaveLength(13)
  expect(f.reads).toHaveLength(13)
})

test("an old release retry cannot move the stable pointer backwards", async () => {
  await using f = await fixture()
  await f.stage()
  const newer = CliRelease.decode({
    ...f.manifest,
    version: "1.99.124",
    targets: Object.fromEntries(
      Object.entries(f.manifest.targets).map(([target, asset]) => [
        target,
        {
          ...asset,
          pathname: asset.pathname.replace("v1.99.123", "v1.99.124"),
          url: asset.url.replace("v1.99.123", "v1.99.124"),
        },
      ]),
    ),
  })
  f.objects.set(CliRelease.manifestPath("latest"), new TextEncoder().encode(JSON.stringify(newer)))
  await expect(commitCliRelease({ identity: f.manifest, store: f.store })).rejects.toThrow("backwards")
  expect(f.writes).toHaveLength(13)
})
