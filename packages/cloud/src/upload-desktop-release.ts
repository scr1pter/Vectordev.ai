import path from "node:path"
import { copy, list, put } from "@vercel/blob"
import {
  createDesktopDownloadManifest,
  createDesktopReleaseIntegrityManifest,
  desktopDownloadTargets,
  desktopReleaseCommitScope,
  desktopReleasePhase,
  desktopUpdateAssetNames,
  desktopUpdaterMetadataFiles,
  latestDesktopDownloadManifestPath,
  parseDesktopDownloadManifest,
  parseDesktopReleaseChecksums,
  parseDesktopReleaseIntegrityManifest,
  validateDesktopRelease,
  validateDesktopReleaseAssetBytes,
  versionedDesktopDownloadManifestPath,
  versionedDesktopReleaseIntegrityPath,
  versionedDesktopUpdaterPath,
} from "./desktop-release-manifest"
import { desktopReleaseVersion } from "./desktop-release-version"

const version = desktopReleaseVersion(process.env.VECTOR_RELEASE_VERSION)
const channel = process.env.VECTOR_RELEASE_CHANNEL === "beta" ? "beta" : "latest"
const phase = desktopReleasePhase(process.env.VECTOR_RELEASE_PHASE)
const commitScope = desktopReleaseCommitScope(process.env.VECTOR_RELEASE_COMMIT_SCOPE)
const source = path.resolve(process.env.VECTOR_RELEASE_DIR ?? path.join(import.meta.dir, "../../desktop/dist"))
const dryRun = process.env.VECTOR_RELEASE_DRY_RUN === "true"
const blobToken = process.env.BLOB_READ_WRITE_TOKEN
const blobOptions = {
  access: "public",
  addRandomSuffix: false,
  token: blobToken,
} as const
const immutableOptions = { ...blobOptions, allowOverwrite: false } as const
const mutableOptions = {
  ...blobOptions,
  allowOverwrite: true,
  cacheControlMaxAge: 60,
} as const
const putOptions = {
  ...immutableOptions,
  multipart: true,
} as const

if (!dryRun && !blobToken) throw new Error("BLOB_READ_WRITE_TOKEN is required")
if (commitScope === "downloads" && channel !== "latest") {
  throw new Error("Download-only desktop releases require the stable channel")
}

const asset = (name: string) => `vector-desktop-${version}-${name}`
const downloads = new Map<string, string>([
  ...desktopDownloadTargets.map((definition) => [asset(definition.asset), definition.filename] as const),
  ["checksums.txt", "checksums.txt"],
])
const updateAssets = desktopUpdateAssetNames(version)
const updateMetadata = [...desktopUpdaterMetadataFiles]
const updatePrefix = channel === "beta" ? "releases/vector-beta-updates" : "releases/vector-updates"

if (phase === "stage" || phase === "all") await stageRelease()
if (phase === "commit" || phase === "all") await commitRelease()

async function stageRelease() {
  const local = await validateLocalRelease()
  const immutableUrls = new Map<string, string>()

  for (const name of new Set([...updateAssets, ...downloads.keys()])) {
    const downloadName = downloads.get(name)
    const pathnames = [
      ...(downloadName ? [`releases/vector-v${version}/${downloadName}`] : []),
      ...(updateAssets.includes(name) ? [versionedDesktopUpdaterPath(version, name)] : []),
    ]
    const record = local.files.get(name)
    if (!record) throw new Error(`Missing validated desktop release asset: ${name}`)
    immutableUrls.set(name, await publishImmutableFile(name, pathnames, record))
  }

  for (const name of updateMetadata) {
    const record = local.files.get(name)
    if (!record) throw new Error(`Missing validated desktop release metadata: ${name}`)
    await publishImmutableFile(name, [versionedDesktopUpdaterPath(version, name)], record)
  }

  const integrity = createDesktopReleaseIntegrityManifest({
    version,
    channel,
    assets: local.updateAssets,
    destinations: Object.fromEntries(
      local.updateAssets.map((entry) => {
        const primaryUrl = immutableUrls.get(entry.sourceName)
        if (!primaryUrl) throw new Error(`Missing uploaded updater URL: ${entry.sourceName}`)
        const pathname = versionedDesktopUpdaterPath(version, entry.sourceName)
        return [entry.sourceName, { pathname, url: new URL(`/${pathname}`, primaryUrl).toString() }]
      }),
    ),
  })
  await publishImmutableText(versionedDesktopReleaseIntegrityPath(version), JSON.stringify(integrity, null, 2) + "\n")

  const manifestPath = versionedDesktopDownloadManifestPath(version)
  const existingManifestUrl = dryRun ? undefined : await findBlobUrl(manifestPath)
  const existingManifest = existingManifestUrl
    ? parseDesktopDownloadManifest(JSON.parse(await readStagedText(existingManifestUrl, manifestPath)) as unknown, {
        version,
        channel,
      })
    : undefined
  const manifest = createDesktopDownloadManifest({
    version,
    channel,
    publishedAt: existingManifest?.publishedAt ?? new Date().toISOString(),
    installers: local.installers,
    destinations: Object.fromEntries(
      local.installers.map((installer) => {
        const pathname = `releases/vector-v${version}/${installer.filename}`
        const url = immutableUrls.get(installer.sourceName)
        if (!url) throw new Error(`Missing uploaded desktop release URL: ${installer.sourceName}`)
        return [installer.target, { pathname, url }]
      }),
    ),
  })
  await publishImmutableText(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
}

async function commitRelease() {
  if (dryRun) {
    if (channel === "latest") {
      downloads.forEach((downloadName) => console.log(`validated releases/vector-downloads/${downloadName}`))
    }
    if (commitScope === "full") {
      updateAssets.forEach((name) => console.log(`validated ${updatePrefix}/${name}`))
      updateMetadata.forEach((name) => console.log(`validated ${updatePrefix}/${name}`))
    }
    if (channel === "latest") console.log(`validated ${latestDesktopDownloadManifestPath}`)
    return
  }

  const staged = await verifyStagedRelease()

  if (channel === "latest") {
    for (const target of Object.values(staged.manifest.targets)) {
      await copy(target.url, `releases/vector-downloads/${target.filename}`, mutableOptions)
      console.log(`copied releases/vector-downloads/${target.filename}`)
    }
    await copy(
      stagedUrl(staged.manifest, `releases/vector-v${version}/checksums.txt`),
      "releases/vector-downloads/checksums.txt",
      mutableOptions,
    )
    console.log("copied releases/vector-downloads/checksums.txt")
  }

  if (commitScope === "full") {
    for (const name of updateAssets) {
      await copy(staged.integrity.assets[name].url, `${updatePrefix}/${name}`, {
        ...mutableOptions,
        cacheControlMaxAge: 31_536_000,
      })
      console.log(`copied ${updatePrefix}/${name}`)
    }
    for (const name of updateMetadata) {
      await copy(stagedUrl(staged.manifest, versionedDesktopUpdaterPath(version, name)), `${updatePrefix}/${name}`, {
        ...mutableOptions,
        contentType: "text/yaml",
      })
      console.log(`copied ${updatePrefix}/${name}`)
    }
  }

  // The public download manifest is the stable commit point and must remain the
  // final operation. Beta releases have no stable download aliases or manifest.
  if (channel === "latest") {
    await copy(staged.manifestUrl, latestDesktopDownloadManifestPath, {
      ...mutableOptions,
      contentType: "application/json",
    })
    console.log(`copied ${latestDesktopDownloadManifestPath}`)
  }
}

async function validateLocalRelease() {
  const required = new Set([...downloads.keys(), ...updateAssets, ...updateMetadata])
  const missing = (
    await Promise.all(
      [...required].map(async (name) => ({ name, present: await Bun.file(path.join(source, name)).exists() })),
    )
  ).filter((entry) => !entry.present)
  if (missing.length) {
    throw new Error(`Missing desktop release asset: ${missing.map((entry) => entry.name).join(", ")}`)
  }

  // Sequential hashing keeps sixteen large cross-platform release payloads from
  // competing for disk bandwidth and finishes before the first immutable upload.
  const files = new Map<string, Awaited<ReturnType<typeof hash>>>()
  for (const name of required) files.set(name, await hash(path.join(source, name)))
  const updateAssetRecords = updateAssets.map((sourceName) => {
    const record = files.get(sourceName)
    if (!record) throw new Error(`Missing hashed updater asset: ${sourceName}`)
    return { sourceName, ...record }
  })
  const installers = desktopDownloadTargets.map((definition) => {
    const sourceName = asset(definition.asset)
    const record = files.get(sourceName)
    if (!record) throw new Error(`Missing hashed desktop installer: ${sourceName}`)
    return {
      target: definition.target,
      sourceName,
      filename: definition.filename,
      ...record,
      updaterMetadata: definition.updaterMetadata,
    }
  })
  const checksums = parseDesktopReleaseChecksums(await Bun.file(path.join(source, "checksums.txt")).text())
  const updaterMetadata = Object.fromEntries(
    await Promise.all(
      updateMetadata.map(async (name) => [name, await Bun.file(path.join(source, name)).text()] as const),
    ),
  )
  validateDesktopRelease({
    version,
    installers,
    updateAssets: updateAssetRecords,
    checksums,
    updaterMetadata,
  })
  return { installers, updateAssets: updateAssetRecords, files }
}

async function verifyStagedRelease() {
  const manifestPath = versionedDesktopDownloadManifestPath(version)
  const manifestUrl = await findStagedUrl(manifestPath)
  const manifest = parseDesktopDownloadManifest(
    JSON.parse(await readStagedText(manifestUrl, manifestPath)) as unknown,
    { version, channel },
  )
  const manifestOrigin = requireStagedUrl(manifestUrl, manifestPath).origin
  if (Object.values(manifest.targets).some((target) => new URL(target.url).origin !== manifestOrigin)) {
    throw new Error("Staged desktop release targets belong to another Blob store")
  }
  const integrityPath = versionedDesktopReleaseIntegrityPath(version)
  const integrityUrl = await findStagedUrl(integrityPath)
  if (requireStagedUrl(integrityUrl, integrityPath).origin !== manifestOrigin) {
    throw new Error("Staged desktop release integrity manifest belongs to another Blob store")
  }
  const integrity = parseDesktopReleaseIntegrityManifest(
    JSON.parse(await readStagedText(integrityUrl, integrityPath)) as unknown,
    { version, channel },
  )
  if (Object.values(integrity.assets).some((entry) => new URL(entry.url).origin !== manifestOrigin)) {
    throw new Error("Staged updater assets belong to another Blob store")
  }
  const checksumsPath = `releases/vector-v${version}/checksums.txt`
  const checksums = parseDesktopReleaseChecksums(
    await readStagedText(stagedUrl(manifest, checksumsPath), checksumsPath),
  )
  const updaterMetadata = Object.fromEntries(
    await Promise.all(
      updateMetadata.map(
        async (name) =>
          [
            name,
            await readStagedText(
              stagedUrl(manifest, versionedDesktopUpdaterPath(version, name)),
              versionedDesktopUpdaterPath(version, name),
            ),
          ] as const,
      ),
    ),
  )
  const updateAssetRecords = updateAssets.map((name) => ({ sourceName: name, ...integrity.assets[name] }))
  const installers = desktopDownloadTargets.map((definition) => {
    const sourceName = asset(definition.asset)
    const target = manifest.targets[definition.target]
    const updater = integrity.assets[sourceName]
    return {
      target: definition.target,
      sourceName,
      filename: target.filename,
      size: target.size,
      sha256: target.sha256,
      sha512: updater.sha512,
      updaterMetadata: definition.updaterMetadata,
    }
  })
  validateDesktopRelease({
    version,
    installers,
    updateAssets: updateAssetRecords,
    checksums,
    updaterMetadata,
  })
  for (const entry of Object.values(integrity.assets)) await verifyRemoteAsset(entry.url, entry.pathname, entry)
  for (const definition of desktopDownloadTargets) {
    const target = manifest.targets[definition.target]
    const updater = integrity.assets[asset(definition.asset)]
    await verifyRemoteAsset(target.url, target.pathname, {
      size: target.size,
      sha256: target.sha256,
      sha512: updater.sha512,
    })
  }
  return { manifest, manifestUrl, integrity }
}

async function publishImmutableFile(
  name: string,
  pathnames: string[],
  expected: { size: number; sha256: string; sha512: string },
) {
  const primaryPathname = pathnames[0]
  if (!primaryPathname) throw new Error(`No desktop release destination for: ${name}`)
  if (dryRun) {
    pathnames.forEach((pathname) => console.log(`validated ${pathname}`))
    return `https://dry-run.invalid/${primaryPathname}`
  }

  const existing = await findBlobUrl(primaryPathname)
  const primaryUrl = existing ?? (await put(primaryPathname, Bun.file(path.join(source, name)), putOptions)).url
  if (existing) {
    await verifyRemoteAsset(existing, primaryPathname, expected)
    console.log(`reused ${primaryPathname}`)
  } else console.log(`uploaded ${primaryPathname}`)

  for (const pathname of pathnames.slice(1)) {
    const copied = await findBlobUrl(pathname)
    if (copied) {
      await verifyRemoteAsset(copied, pathname, expected)
      console.log(`reused ${pathname}`)
      continue
    }
    await copy(primaryUrl, pathname, immutableOptions)
    console.log(`copied ${pathname}`)
  }
  return primaryUrl
}

async function publishImmutableText(pathname: string, contents: string) {
  const expected = hashBytes(Buffer.from(contents))
  if (dryRun) {
    console.log(`validated ${pathname}`)
    return
  }
  const existing = await findBlobUrl(pathname)
  if (existing) {
    await verifyRemoteAsset(existing, pathname, expected)
    console.log(`reused ${pathname}`)
    return
  }
  await put(pathname, contents, { ...immutableOptions, contentType: "application/json" })
  console.log(`uploaded ${pathname}`)
}

async function readStagedText(url: string, pathname: string) {
  const request = new URL(url)
  request.searchParams.set("release-validation", `${Date.now()}`)
  const response = await fetch(request, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  })
  if (!response.ok) {
    throw new Error(`Missing staged desktop release object: ${pathname}`)
  }
  return response.text()
}

async function findStagedUrl(pathname: string) {
  const url = await findBlobUrl(pathname)
  if (!url) throw new Error(`Missing staged desktop release object: ${pathname}`)
  return url
}

async function findBlobUrl(pathname: string) {
  const result = await list({ prefix: pathname, limit: 10, token: blobToken })
  const blob = result.blobs.find((entry) => entry.pathname === pathname)
  return blob?.url
}

function stagedUrl(manifest: ReturnType<typeof parseDesktopDownloadManifest>, pathname: string) {
  const target = Object.values(manifest.targets)[0]
  if (!target) throw new Error("Desktop download manifest has no targets")
  return new URL(`/${pathname}`, target.url).toString()
}

function requireStagedUrl(input: string, pathname: string) {
  if (!URL.canParse(input)) throw new Error(`Invalid staged desktop release URL: ${input}`)
  const url = new URL(input)
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9][a-z0-9-]*\.public\.blob\.vercel-storage\.com$/i.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname.replace(/^\//, "") !== pathname ||
    input !== `${url.origin}/${pathname}`
  ) {
    throw new Error(`Invalid staged desktop release URL: ${input}`)
  }
  return url
}

async function hash(file: string) {
  return hashStream(Bun.file(file).stream())
}

function hashBytes(bytes: Uint8Array) {
  const sha256 = new Bun.CryptoHasher("sha256")
  const sha512 = new Bun.CryptoHasher("sha512")
  sha256.update(bytes)
  sha512.update(bytes)
  return { size: bytes.byteLength, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") }
}

async function hashStream(stream: ReadableStream<Uint8Array>) {
  const sha256 = new Bun.CryptoHasher("sha256")
  const sha512 = new Bun.CryptoHasher("sha512")
  const reader = stream.getReader()
  let size = 0
  while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    const chunk = part.value
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return { size, sha256: sha256.digest("hex"), sha512: sha512.digest("base64") }
}

async function verifyRemoteAsset(
  url: string,
  pathname: string,
  expected: { size: number; sha256: string; sha512: string },
) {
  const request = new URL(url)
  request.searchParams.set("release-validation", `${Date.now()}`)
  const response = await fetch(request, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
  })
  if (!response.ok || !response.body) throw new Error(`Missing staged desktop release object: ${pathname}`)
  const actual = await hashStream(response.body)
  validateDesktopReleaseAssetBytes(pathname, actual, expected)
}
