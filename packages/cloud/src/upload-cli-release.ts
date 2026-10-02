import path from "node:path"
import { list, put } from "@vercel/blob"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { cliBlobUrl, hashCliFile, packageCliRelease } from "./cli-release-package"
import { assertCleanArtifacts } from "../../../script/artifact-audit"

export type CliReleaseStore = {
  origin: string
  find: (pathname: string) => Promise<{ url: string } | undefined>
  write: (pathname: string, body: Bun.BunFile | string, mutable: boolean) => Promise<{ url: string }>
  request?: (url: string, init: RequestInit) => Promise<Response>
}

export type CliReleaseIdentity = Pick<CliRelease.Manifest, "version" | "channel" | "sourceRevision" | "catalogSha256">

export async function stageCliRelease(input: {
  directory: string
  manifest: CliRelease.Manifest
  store: CliReleaseStore
}) {
  const manifest = CliRelease.decode(input.manifest, input.store.origin)
  // Finish validating the whole local matrix before the first upload.
  for (const target of CliRelease.targets) {
    const asset = manifest.targets[target]!
    equalBytes(await hashCliFile(path.join(input.directory, asset.filename)), asset, asset.pathname)
  }
  await assertCleanArtifacts(
    CliRelease.targets.map((target) => path.join(input.directory, manifest.targets[target]!.filename)),
  )
  const pathname = CliRelease.manifestPath(manifest.version)
  const existing = await input.store.find(pathname)
  const staged = existing
    ? CliRelease.decode(JSON.parse(await remoteText(input.store, pathname, existing.url)), input.store.origin)
    : manifest
  if (JSON.stringify({ ...staged, publishedAt: manifest.publishedAt }) !== JSON.stringify(manifest))
    throw new Error("An immutable CLI manifest already exists with different release content.")
  for (const target of CliRelease.targets) {
    const asset = manifest.targets[target]!
    await immutable(input.store, asset.pathname, Bun.file(path.join(input.directory, asset.filename)), asset)
  }
  const text = JSON.stringify(staged, null, 2) + "\n"
  await immutable(input.store, pathname, text, {
    size: Buffer.byteLength(text),
    sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
  })
  return staged
}

export async function verifyStagedCliRelease(input: { identity: CliReleaseIdentity; store: CliReleaseStore }) {
  const pathname = CliRelease.manifestPath(input.identity.version)
  const found = await input.store.find(pathname)
  if (!found) throw new Error("The immutable CLI manifest has not been staged.")
  const text = await remoteText(input.store, pathname, found.url)
  const manifest = CliRelease.decode(JSON.parse(text), input.store.origin)
  for (const field of ["version", "channel", "sourceRevision", "catalogSha256"] as const)
    if (manifest[field] !== input.identity[field]) throw new Error(`The staged CLI release has a different ${field}.`)
  for (const target of CliRelease.targets) {
    const asset = manifest.targets[target]!
    await verifyBytes(input.store, asset.pathname, asset.url, asset)
  }
  return { manifest, text }
}

export async function commitCliRelease(input: { identity: CliReleaseIdentity; store: CliReleaseStore }) {
  const staged = await verifyStagedCliRelease(input)
  const pathname = CliRelease.manifestPath(staged.manifest.channel)
  const current = await input.store.find(pathname)
  if (current) {
    const manifest = CliRelease.decode(
      JSON.parse(await remoteText(input.store, pathname, current.url)),
      input.store.origin,
    )
    if (manifest.channel !== staged.manifest.channel || Bun.semver.order(manifest.version, staged.manifest.version) > 0)
      throw new Error("Refusing to move the CLI channel backwards or across channels.")
    if (manifest.version === staged.manifest.version && JSON.stringify(manifest) !== JSON.stringify(staged.manifest))
      throw new Error("The current CLI version has different immutable release content.")
  }
  // Release workflow concurrency must serialize commits to the same channel.
  // Blob has no compare-and-swap; this is the sole mutable write/commit point.
  const result = await input.store.write(pathname, staged.text, true)
  requireUrl(input.store, pathname, result.url)
  return staged.manifest
}

async function immutable(
  store: CliReleaseStore,
  pathname: string,
  body: Bun.BunFile | string,
  expected: { size: number; sha256: string },
) {
  const existing = await store.find(pathname)
  if (existing) return verifyBytes(store, pathname, existing.url, expected)
  const result = await store.write(pathname, body, false).catch(async (error: unknown) => {
    // Another staging attempt may have won the immutable create. Reconcile
    // only an object whose exact bytes can be verified; never overwrite it.
    const raced = await store.find(pathname)
    if (!raced) throw error
    return raced
  })
  await verifyBytes(store, pathname, result.url, expected)
}

function requireUrl(store: CliReleaseStore, pathname: string, url: string) {
  if (url !== cliBlobUrl(store.origin, pathname))
    throw new Error("The CLI release belongs to a different Blob object or store.")
}

async function response(store: CliReleaseStore, pathname: string, url: string) {
  requireUrl(store, pathname, url)
  const result = await (store.request ?? fetch)(url, {
    redirect: "error",
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    signal: AbortSignal.timeout(120_000),
  })
  if (!result.ok || !result.body) {
    await result.body?.cancel()
    throw new Error(`The staged CLI object is unavailable: ${pathname}.`)
  }
  return result
}

async function remoteText(store: CliReleaseStore, pathname: string, url: string) {
  const result = await response(store, pathname, url)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = result.body!.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > CliRelease.MAX_MANIFEST_BYTES) throw new Error("The staged CLI manifest exceeds the size limit.")
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function verifyBytes(
  store: CliReleaseStore,
  pathname: string,
  url: string,
  expected: { size: number; sha256: string },
) {
  const result = await response(store, pathname, url)
  const reader = result.body!.getReader()
  const hash = new Bun.CryptoHasher("sha256")
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > expected.size) throw new Error(`The staged CLI bytes exceed their recorded size: ${pathname}.`)
      hash.update(chunk.value)
    }
    equalBytes({ size, sha256: hash.digest("hex") }, expected, pathname)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function equalBytes(
  actual: { size: number; sha256: string },
  expected: { size: number; sha256: string },
  pathname: string,
) {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
    throw new Error(`The CLI release bytes differ from the manifest: ${pathname}.`)
}

if (import.meta.main) {
  const phase = process.argv[2] ?? "prepare"
  if (!["prepare", "stage", "verify", "commit", "all"].includes(phase))
    throw new Error("Expected prepare, stage, verify, commit or all.")
  const required = (name: string) => {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required.`)
    return value
  }
  const origin = required("VECTOR_CLI_BLOB_ORIGIN")
  cliBlobUrl(origin, "")
  const channel = process.env.VECTOR_RELEASE_CHANNEL ?? "latest"
  if (channel !== "latest" && channel !== "beta") throw new Error("VECTOR_RELEASE_CHANNEL must be latest or beta.")
  const identity: CliReleaseIdentity = {
    version: required("VECTOR_RELEASE_VERSION"),
    channel,
    sourceRevision: required("VECTOR_SOURCE_REVISION"),
    catalogSha256: required("VECTOR_CATALOG_SHA256"),
  }
  const directory = path.resolve(
    process.env.VECTOR_CLI_RELEASE_DIR ?? path.join(import.meta.dir, "../../engine/dist-cli"),
  )
  if (phase === "prepare" || phase === "all") {
    await packageCliRelease({
      ...identity,
      origin,
      source: path.resolve(process.env.VECTOR_CLI_RELEASE_SOURCE ?? path.join(import.meta.dir, "../../engine/dist")),
      output: directory,
      publishedAt: required("VECTOR_RELEASE_PUBLISHED_AT"),
    })
    console.log(`Prepared all twelve CLI archives in ${directory}`)
  }
  if (phase !== "prepare") {
    const token = required("BLOB_READ_WRITE_TOKEN")
    const store: CliReleaseStore = {
      origin,
      find: async (pathname) =>
        (await list({ prefix: pathname, limit: 10, token })).blobs.find((item) => item.pathname === pathname),
      write: (pathname, body, mutable) =>
        put(pathname, body, {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: mutable,
          contentType: pathname.endsWith(".json")
            ? "application/json"
            : pathname.endsWith(".zip")
              ? "application/zip"
              : "application/gzip",
          cacheControlMaxAge: mutable ? 60 : 31_536_000,
          multipart: !pathname.endsWith(".json"),
          token,
        }),
    }
    if (phase === "stage" || phase === "all") {
      const file = Bun.file(path.join(directory, "manifest.json"))
      if (file.size > CliRelease.MAX_MANIFEST_BYTES)
        throw new Error("The prepared CLI manifest exceeds the size limit.")
      const manifest = CliRelease.decode(await file.json(), origin)
      for (const field of ["version", "channel", "sourceRevision", "catalogSha256"] as const)
        if (manifest[field] !== identity[field]) throw new Error(`The prepared CLI release has a different ${field}.`)
      await stageCliRelease({ directory, manifest, store })
      console.log(`Staged CLI ${identity.version}`)
    }
    if (phase === "verify") {
      await verifyStagedCliRelease({ identity, store })
      console.log(`Verified immutable CLI ${identity.version}`)
    }
    if (phase === "commit" || phase === "all") {
      await commitCliRelease({ identity, store })
      console.log(`Committed CLI ${identity.version} to ${channel}`)
    }
  }
}
