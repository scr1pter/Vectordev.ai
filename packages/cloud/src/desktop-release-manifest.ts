export const desktopDownloadTargets = [
  {
    target: "mac-arm64",
    asset: "mac-arm64.dmg",
    filename: "vector-desktop-mac-arm64.dmg",
    updaterMetadata: "latest-mac.yml",
  },
  {
    target: "mac-x64",
    asset: "mac-x64.dmg",
    filename: "vector-desktop-mac-x64.dmg",
    updaterMetadata: "latest-mac.yml",
  },
  {
    target: "windows-x64",
    asset: "win-x64.exe",
    filename: "vector-desktop-win-x64.exe",
    updaterMetadata: "latest.yml",
  },
  {
    target: "windows-arm64",
    asset: "win-arm64.exe",
    filename: "vector-desktop-win-arm64.exe",
    updaterMetadata: "latest.yml",
  },
  {
    target: "linux-x64",
    asset: "linux-x86_64.AppImage",
    filename: "vector-desktop-linux-x86_64.AppImage",
    updaterMetadata: "latest-linux.yml",
  },
  {
    target: "linux-arm64",
    asset: "linux-arm64.AppImage",
    filename: "vector-desktop-linux-arm64.AppImage",
    updaterMetadata: "latest-linux-arm64.yml",
  },
] as const

export const desktopUpdaterAssets = [
  { asset: "mac-arm64.dmg", updaterMetadata: "latest-mac.yml", advertised: true },
  { asset: "mac-arm64.dmg.blockmap", updaterMetadata: "latest-mac.yml", advertised: false },
  { asset: "mac-arm64.zip", updaterMetadata: "latest-mac.yml", advertised: true },
  { asset: "mac-arm64.zip.blockmap", updaterMetadata: "latest-mac.yml", advertised: false },
  { asset: "mac-x64.dmg", updaterMetadata: "latest-mac.yml", advertised: true },
  { asset: "mac-x64.dmg.blockmap", updaterMetadata: "latest-mac.yml", advertised: false },
  { asset: "mac-x64.zip", updaterMetadata: "latest-mac.yml", advertised: true },
  { asset: "mac-x64.zip.blockmap", updaterMetadata: "latest-mac.yml", advertised: false },
  { asset: "win.exe", updaterMetadata: "latest.yml", advertised: true },
  { asset: "win.exe.blockmap", updaterMetadata: "latest.yml", advertised: false },
  { asset: "win-x64.exe", updaterMetadata: "latest.yml", advertised: true },
  { asset: "win-x64.exe.blockmap", updaterMetadata: "latest.yml", advertised: false },
  { asset: "win-arm64.exe", updaterMetadata: "latest.yml", advertised: true },
  { asset: "win-arm64.exe.blockmap", updaterMetadata: "latest.yml", advertised: false },
  { asset: "linux-x86_64.AppImage", updaterMetadata: "latest-linux.yml", advertised: true },
  { asset: "linux-arm64.AppImage", updaterMetadata: "latest-linux-arm64.yml", advertised: true },
] as const

export const desktopUpdaterMetadataFiles = [
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
] as const

export type DesktopDownloadTarget = (typeof desktopDownloadTargets)[number]["target"]

export type DesktopInstallerRecord = {
  target: DesktopDownloadTarget
  sourceName: string
  filename: string
  size: number
  sha256: string
  sha512: string
  updaterMetadata: string
}

export type DesktopUpdateAssetRecord = {
  sourceName: string
  size: number
  sha256: string
  sha512: string
}

export type DesktopReleaseChannel = "latest" | "beta"
export type DesktopReleasePhase = "stage" | "commit" | "all"
export type DesktopReleaseCommitScope = "downloads" | "full"

export type DesktopDownloadManifest = {
  schemaVersion: 1
  version: string
  channel: DesktopReleaseChannel
  publishedAt: string
  targets: Record<
    string,
    {
      filename: string
      pathname: string
      url: string
      size: number
      sha256: string
      verification: "release-workflow"
    }
  >
}

export type DesktopReleaseIntegrityManifest = {
  schemaVersion: 1
  version: string
  channel: DesktopReleaseChannel
  assets: Record<
    string,
    {
      pathname: string
      url: string
      size: number
      sha256: string
      sha512: string
    }
  >
}

export function desktopUpdateAssetNames(version: string) {
  return desktopUpdaterAssets.map((definition) => `vector-desktop-${version}-${definition.asset}`)
}

export function validateDesktopReleaseAssetBytes(
  pathname: string,
  actual: { size: number; sha256: string; sha512: string },
  expected: { size: number; sha256: string; sha512: string },
) {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256 || actual.sha512 !== expected.sha512) {
    throw new Error(`Immutable desktop release object does not match validated bytes: ${pathname}`)
  }
}

export function parseDesktopReleaseChecksums(contents: string) {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((checksums, line) => {
      const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/)
      if (!match) throw new Error(`Invalid checksums.txt entry: ${line}`)
      const name = match[2]
      if (checksums[name]) throw new Error(`Duplicate checksums.txt entry: ${name}`)
      checksums[name] = match[1].toLowerCase()
      return checksums
    }, {})
}

export function validateDesktopRelease(input: {
  version: string
  installers: readonly DesktopInstallerRecord[]
  updateAssets: readonly DesktopUpdateAssetRecord[]
  checksums: Readonly<Record<string, string>>
  updaterMetadata: Readonly<Record<string, string>>
}) {
  if (input.installers.length !== desktopDownloadTargets.length) {
    throw new Error(`Expected ${desktopDownloadTargets.length} desktop installers, got ${input.installers.length}`)
  }
  if (Object.keys(input.updaterMetadata).sort().join("\n") !== desktopUpdaterMetadataFiles.slice().sort().join("\n")) {
    throw new Error("Desktop release does not contain exactly the expected updater metadata files")
  }
  const metadata = Object.fromEntries(
    desktopUpdaterMetadataFiles.map((name) => [name, parseDesktopUpdaterMetadata(name, input.updaterMetadata[name])]),
  )

  Object.entries(metadata).forEach(([name, value]) => {
    if (value.version !== input.version) {
      throw new Error(`${name} version mismatch: expected ${input.version}, got ${value.version}`)
    }
  })

  const updateAssets = new Map(input.updateAssets.map((entry) => [entry.sourceName, entry]))
  const expectedUpdateAssets = desktopUpdateAssetNames(input.version)
  if (updateAssets.size !== input.updateAssets.length) throw new Error("Desktop release has duplicate updater assets")
  if ([...updateAssets.keys()].sort().join("\n") !== expectedUpdateAssets.slice().sort().join("\n")) {
    throw new Error("Desktop release does not contain exactly the expected updater assets")
  }
  input.updateAssets.forEach((entry) => {
    validateAssetRecord(entry)
    const checksum = input.checksums[entry.sourceName]
    if (!checksum) throw new Error(`checksums.txt has no entry for ${entry.sourceName}`)
    if (checksum !== entry.sha256) {
      throw new Error(
        `checksums.txt sha256 mismatch for ${entry.sourceName}: expected ${entry.sha256}, got ${checksum}`,
      )
    }
  })

  const updaterFiles = new Map<string, string>()
  Object.entries(metadata).forEach(([name, value]) => {
    value.files.forEach((file) => {
      if (updaterFiles.has(file.url)) throw new Error(`Duplicate updater metadata URL: ${file.url}`)
      const definition = desktopUpdaterAssets.find(
        (entry) => `vector-desktop-${input.version}-${entry.asset}` === file.url,
      )
      if (!definition || !definition.advertised || definition.updaterMetadata !== name) {
        throw new Error(`${name} references unknown updater asset: ${file.url}`)
      }
      const actual = updateAssets.get(file.url)
      if (!actual) throw new Error(`${name} references missing updater asset: ${file.url}`)
      if (file.size !== actual.size) {
        throw new Error(`${name} size mismatch for ${file.url}: expected ${actual.size}, got ${file.size}`)
      }
      if (file.sha512 !== actual.sha512) {
        throw new Error(`${name} sha512 mismatch for ${file.url}: expected ${actual.sha512}, got ${file.sha512}`)
      }
      updaterFiles.set(file.url, name)
    })
  })
  desktopUpdaterAssets
    .filter((definition) => definition.advertised)
    .forEach((definition) => {
      const name = `vector-desktop-${input.version}-${definition.asset}`
      if (!updaterFiles.has(name)) throw new Error(`${definition.updaterMetadata} has no entry for ${name}`)
    })

  const installers = new Map(input.installers.map((installer) => [installer.target, installer]))
  if (installers.size !== input.installers.length) throw new Error("Desktop release has duplicate installer targets")
  const validated = desktopDownloadTargets.map((definition) => {
    const installer = installers.get(definition.target)
    if (!installer) throw new Error(`Missing desktop release installer: ${definition.target}`)
    const sourceName = `vector-desktop-${input.version}-${definition.asset}`
    if (installer.sourceName !== sourceName || installer.updaterMetadata !== definition.updaterMetadata) {
      throw new Error(`Desktop release installer identity mismatch: ${definition.target}`)
    }
    if (installer.filename !== definition.filename) {
      throw new Error(
        `${definition.target} filename mismatch: expected ${definition.filename}, got ${installer.filename}`,
      )
    }
    validateAssetRecord(installer)

    const checksum = input.checksums[installer.sourceName]
    if (!checksum) throw new Error(`checksums.txt has no entry for ${installer.sourceName}`)
    if (checksum !== installer.sha256) {
      throw new Error(
        `checksums.txt sha256 mismatch for ${installer.sourceName}: expected ${installer.sha256}, got ${checksum}`,
      )
    }
    const downloadChecksum = input.checksums[installer.filename]
    if (!downloadChecksum) throw new Error(`checksums.txt has no entry for ${installer.filename}`)
    if (downloadChecksum !== installer.sha256) {
      throw new Error(
        `checksums.txt sha256 mismatch for ${installer.filename}: expected ${installer.sha256}, got ${downloadChecksum}`,
      )
    }

    const updater = metadata[installer.updaterMetadata]
    if (!updater) throw new Error(`Missing updater metadata: ${installer.updaterMetadata}`)
    const updaterFile = updater.files.find((file) => file.url === installer.sourceName)
    if (!updaterFile) {
      throw new Error(`${installer.updaterMetadata} has no entry for ${installer.sourceName}`)
    }
    if (updaterFile.size !== installer.size) {
      throw new Error(
        `${installer.updaterMetadata} size mismatch for ${installer.sourceName}: expected ${installer.size}, got ${updaterFile.size}`,
      )
    }
    if (updaterFile.sha512 !== installer.sha512) {
      throw new Error(
        `${installer.updaterMetadata} sha512 mismatch for ${installer.sourceName}: expected ${installer.sha512}, got ${updaterFile.sha512}`,
      )
    }
    return installer
  })

  return validated
}

export function createDesktopDownloadManifest(input: {
  version: string
  channel: DesktopReleaseChannel
  publishedAt: string
  installers: readonly DesktopInstallerRecord[]
  destinations: Readonly<Partial<Record<DesktopDownloadTarget, { pathname: string; url: string }>>>
}): DesktopDownloadManifest {
  const installers = new Map(input.installers.map((installer) => [installer.target, installer]))
  return {
    schemaVersion: 1,
    version: input.version,
    channel: input.channel,
    publishedAt: input.publishedAt,
    targets: Object.fromEntries(
      desktopDownloadTargets.map((definition) => {
        const installer = installers.get(definition.target)
        if (!installer) throw new Error(`Missing desktop release installer: ${definition.target}`)
        const destination = input.destinations[definition.target]
        if (!destination) throw new Error(`Missing immutable desktop release destination: ${definition.target}`)
        return [
          definition.target,
          {
            filename: installer.filename,
            pathname: destination.pathname,
            url: destination.url,
            size: installer.size,
            sha256: installer.sha256,
            verification: "release-workflow" as const,
          },
        ]
      }),
    ),
  }
}

export function createDesktopReleaseIntegrityManifest(input: {
  version: string
  channel: DesktopReleaseChannel
  assets: readonly DesktopUpdateAssetRecord[]
  destinations: Readonly<Record<string, { pathname: string; url: string }>>
}): DesktopReleaseIntegrityManifest {
  return {
    schemaVersion: 1,
    version: input.version,
    channel: input.channel,
    assets: Object.fromEntries(
      input.assets.map((asset) => {
        const destination = input.destinations[asset.sourceName]
        if (!destination) throw new Error(`Missing immutable updater destination: ${asset.sourceName}`)
        return [
          asset.sourceName,
          {
            pathname: destination.pathname,
            url: destination.url,
            size: asset.size,
            sha256: asset.sha256,
            sha512: asset.sha512,
          },
        ]
      }),
    ),
  }
}

export function parseDesktopReleaseIntegrityManifest(
  input: unknown,
  expected: { version: string; channel: DesktopReleaseChannel },
): DesktopReleaseIntegrityManifest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["schemaVersion", "version", "channel", "assets"]) ||
    input.schemaVersion !== 1
  ) {
    throw new Error("Desktop release integrity schema is invalid")
  }
  if (input.version !== expected.version || input.channel !== expected.channel || !isRecord(input.assets)) {
    throw new Error("Desktop release integrity identity is invalid")
  }
  const expectedAssets = desktopUpdateAssetNames(expected.version)
  if (Object.keys(input.assets).sort().join("\n") !== expectedAssets.slice().sort().join("\n")) {
    throw new Error("Desktop release integrity manifest does not contain exactly the expected updater assets")
  }
  const manifestAssets = input.assets
  const origins = new Set<string>()
  const assets = expectedAssets.reduce<DesktopReleaseIntegrityManifest["assets"]>((result, name) => {
    const asset = manifestAssets[name]
    const pathname = versionedDesktopUpdaterPath(expected.version, name)
    if (
      !isRecord(asset) ||
      !hasExactKeys(asset, ["pathname", "url", "size", "sha256", "sha512"]) ||
      asset.pathname !== pathname ||
      typeof asset.url !== "string"
    ) {
      throw new Error(`Desktop release integrity asset is invalid: ${name}`)
    }
    if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Desktop release integrity asset size is invalid: ${name}`)
    }
    if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`Desktop release integrity asset sha256 is invalid: ${name}`)
    }
    if (typeof asset.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(asset.sha512)) {
      throw new Error(`Desktop release integrity asset sha512 is invalid: ${name}`)
    }
    const url = parseDesktopBlobUrl(asset.url, pathname)
    origins.add(url.origin)
    result[name] = {
      pathname,
      url: asset.url,
      size: asset.size,
      sha256: asset.sha256,
      sha512: asset.sha512,
    }
    return result
  }, {})
  if (origins.size !== 1) throw new Error("Desktop release integrity assets must use exactly one Blob origin")
  return { schemaVersion: 1, version: expected.version, channel: expected.channel, assets }
}

export function parseDesktopDownloadManifest(
  input: unknown,
  expected: { version: string; channel: DesktopReleaseChannel },
): DesktopDownloadManifest {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["schemaVersion", "version", "channel", "publishedAt", "targets"]) ||
    input.schemaVersion !== 1
  ) {
    throw new Error("Desktop download manifest schema is invalid")
  }
  if (input.version !== expected.version) {
    throw new Error(
      `Desktop download manifest version mismatch: expected ${expected.version}, got ${String(input.version)}`,
    )
  }
  if (input.channel !== expected.channel) {
    throw new Error(
      `Desktop download manifest channel mismatch: expected ${expected.channel}, got ${String(input.channel)}`,
    )
  }
  if (typeof input.publishedAt !== "string" || !Number.isFinite(Date.parse(input.publishedAt))) {
    throw new Error("Desktop download manifest publishedAt is invalid")
  }
  if (!isRecord(input.targets)) throw new Error("Desktop download manifest targets are invalid")
  const manifestTargets = input.targets
  if (
    Object.keys(manifestTargets).sort().join("\n") !==
    desktopDownloadTargets
      .map((entry) => entry.target)
      .sort()
      .join("\n")
  ) {
    throw new Error("Desktop download manifest does not contain exactly six targets")
  }

  const origins = new Set<string>()
  const targets = desktopDownloadTargets.reduce<DesktopDownloadManifest["targets"]>((result, definition) => {
    const target = manifestTargets[definition.target]
    const pathname = `releases/vector-v${expected.version}/${definition.filename}`
    if (
      !isRecord(target) ||
      !hasExactKeys(target, ["filename", "pathname", "url", "size", "sha256", "verification"]) ||
      target.filename !== definition.filename ||
      target.pathname !== pathname
    ) {
      throw new Error(`Desktop download manifest target is invalid: ${definition.target}`)
    }
    if (typeof target.size !== "number" || !Number.isSafeInteger(target.size) || target.size <= 0) {
      throw new Error(`Desktop download manifest target size is invalid: ${definition.target}`)
    }
    if (typeof target.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.sha256)) {
      throw new Error(`Desktop download manifest target sha256 is invalid: ${definition.target}`)
    }
    if (target.verification !== "release-workflow" || typeof target.url !== "string") {
      throw new Error(`Desktop download manifest target verification is invalid: ${definition.target}`)
    }
    const url = parseDesktopBlobUrl(
      target.url,
      pathname,
      `Desktop download manifest target URL is invalid: ${definition.target}`,
    )
    origins.add(url.origin)
    result[definition.target] = {
      filename: definition.filename,
      pathname,
      url: target.url,
      size: target.size,
      sha256: target.sha256,
      verification: "release-workflow",
    }
    return result
  }, {})
  if (origins.size !== 1) throw new Error("Desktop download manifest targets must use exactly one Blob origin")

  return {
    schemaVersion: 1,
    version: expected.version,
    channel: expected.channel,
    publishedAt: input.publishedAt,
    targets,
  }
}

export function desktopReleasePhase(input: string | undefined): DesktopReleasePhase {
  if (!input) return "all"
  if (input === "stage" || input === "commit" || input === "all") return input
  throw new Error(`VECTOR_RELEASE_PHASE must be stage, commit, or all; got ${input}`)
}

export function desktopReleaseCommitScope(input: string | undefined): DesktopReleaseCommitScope {
  if (!input || input === "full") return "full"
  if (input === "downloads") return input
  throw new Error(`VECTOR_RELEASE_COMMIT_SCOPE must be downloads or full; got ${input}`)
}

export function versionedDesktopDownloadManifestPath(version: string) {
  return `releases/vector-v${version}/downloads.json`
}

export function versionedDesktopReleaseIntegrityPath(version: string) {
  return `releases/vector-v${version}/integrity.json`
}

export function versionedDesktopUpdaterPath(version: string, name: string) {
  return `releases/vector-v${version}/updater/${name}`
}

export const latestDesktopDownloadManifestPath = "releases/vector-downloads/latest.json"

export function parseDesktopUpdaterMetadata(name: string, contents: string) {
  const version = contents.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1]
  if (!version) throw new Error(`${name} has no version`)
  const files = contents
    .split(/^\s{2}- url:\s*/m)
    .slice(1)
    .map((section) => {
      const lines = section.split("\n")
      const url = lines[0]?.trim()
      const size = Number(section.match(/^\s{4}size:\s*(\d+)\s*$/m)?.[1])
      const sha512 = section.match(/^\s{4}sha512:\s*(\S+)\s*$/m)?.[1]
      if (!url || !Number.isSafeInteger(size) || size <= 0 || !sha512 || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) {
        throw new Error(`${name} has an invalid updater file entry`)
      }
      return { url, size, sha512 }
    })
  if (!files.length) throw new Error(`${name} has no updater files`)
  return { version, files }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function hasExactKeys(input: Record<string, unknown>, keys: string[]) {
  return Object.keys(input).sort().join("\n") === keys.slice().sort().join("\n")
}

function validateAssetRecord(input: DesktopUpdateAssetRecord) {
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new Error(`${input.sourceName} has invalid size: ${input.size}`)
  }
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) {
    throw new Error(`${input.sourceName} has invalid sha256: ${input.sha256}`)
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(input.sha512)) {
    throw new Error(`${input.sourceName} has invalid sha512: ${input.sha512}`)
  }
}

function parseDesktopBlobUrl(input: string, pathname: string, message = "Desktop release Blob URL is invalid") {
  if (!URL.canParse(input)) throw new Error(message)
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
    throw new Error(message)
  }
  return url
}
