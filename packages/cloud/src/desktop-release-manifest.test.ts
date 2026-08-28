import { describe, expect, test } from "bun:test"
import {
  createDesktopDownloadManifest,
  createDesktopReleaseIntegrityManifest,
  desktopDownloadTargets,
  desktopReleasePhase,
  desktopUpdaterAssets,
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

const version = "1.19.98"
const updateAssets = desktopUpdaterAssets.map((definition, index) => ({
  sourceName: `vector-desktop-${version}-${definition.asset}`,
  size: 1_000 + index,
  sha256: (index % 16).toString(16).repeat(64),
  sha512: Buffer.alloc(64, index + 1).toString("base64"),
}))
const updateAssetsByName = new Map(updateAssets.map((entry) => [entry.sourceName, entry]))
const installers = desktopDownloadTargets.map((definition) => {
  const sourceName = `vector-desktop-${version}-${definition.asset}`
  const record = updateAssetsByName.get(sourceName)
  if (!record) throw new Error(`Missing test updater asset: ${sourceName}`)
  return {
    target: definition.target,
    sourceName,
    filename: definition.filename,
    size: record.size,
    sha256: record.sha256,
    sha512: record.sha512,
    updaterMetadata: definition.updaterMetadata,
  }
})

function updaterMetadata(releaseVersion = version) {
  return Object.fromEntries(
    [...new Set(desktopDownloadTargets.map((definition) => definition.updaterMetadata))].map((name) => [
      name,
      [
        `version: ${releaseVersion}`,
        "files:",
        ...desktopUpdaterAssets
          .filter((definition) => definition.updaterMetadata === name && definition.advertised)
          .flatMap((definition) => {
            const sourceName = `vector-desktop-${version}-${definition.asset}`
            const record = updateAssetsByName.get(sourceName)
            if (!record) throw new Error(`Missing test updater asset: ${sourceName}`)
            return [`  - url: ${record.sourceName}`, `    sha512: ${record.sha512}`, `    size: ${record.size}`]
          }),
        `releaseDate: '2026-08-28T00:00:00.000Z'`,
      ].join("\n"),
    ]),
  )
}

const checksums = Object.fromEntries([
  ...updateAssets.map((entry) => [entry.sourceName, entry.sha256]),
  ...installers.map((entry) => [entry.filename, entry.sha256]),
])

describe("desktop release validation", () => {
  test("accepts six installers whose hashes, sizes, and updater versions agree", () => {
    expect(
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: updaterMetadata() }),
    ).toEqual(installers)
  })

  test("rejects a missing or mismatched checksum", () => {
    const missing = { ...checksums }
    delete missing[installers[0].sourceName]
    expect(() =>
      validateDesktopRelease({
        version,
        installers,
        updateAssets,
        checksums: missing,
        updaterMetadata: updaterMetadata(),
      }),
    ).toThrow("checksums.txt has no entry")

    expect(() =>
      validateDesktopRelease({
        version,
        installers,
        updateAssets,
        checksums: { ...checksums, [installers[0].sourceName]: "f".repeat(64) },
        updaterMetadata: updaterMetadata(),
      }),
    ).toThrow("checksums.txt sha256 mismatch")
  })

  test("rejects stale updater metadata and installer size drift", () => {
    expect(() =>
      validateDesktopRelease({
        version,
        installers,
        updateAssets,
        checksums,
        updaterMetadata: updaterMetadata("1.19.97"),
      }),
    ).toThrow("version mismatch: expected 1.19.98, got 1.19.97")

    const changed = updaterMetadata()
    changed["latest-mac.yml"] = changed["latest-mac.yml"].replace(
      `size: ${installers[0].size}`,
      `size: ${installers[0].size + 1}`,
    )
    expect(() =>
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: changed }),
    ).toThrow("size mismatch")
  })

  test("rejects installer sha512 drift in updater metadata", () => {
    const changed = updaterMetadata()
    changed["latest-mac.yml"] = changed["latest-mac.yml"].replace(
      installers[0].sha512,
      Buffer.alloc(64, 255).toString("base64"),
    )
    expect(() =>
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: changed }),
    ).toThrow("sha512 mismatch")
  })

  test("rejects corruption in a non-installer updater payload", () => {
    const blockmap = updateAssets.find((entry) => entry.sourceName.endsWith("mac-arm64.zip.blockmap"))
    if (!blockmap) throw new Error("Missing test blockmap")
    const corrupted = updateAssets.map((entry) =>
      entry.sourceName === blockmap.sourceName ? { ...entry, sha256: "f".repeat(64) } : entry,
    )
    expect(() =>
      validateDesktopRelease({
        version,
        installers,
        updateAssets: corrupted,
        checksums,
        updaterMetadata: updaterMetadata(),
      }),
    ).toThrow(`checksums.txt sha256 mismatch for ${blockmap.sourceName}`)
  })

  test("rejects unknown, duplicate, and missing updater metadata URLs", () => {
    const unknown = updaterMetadata()
    unknown["latest.yml"] = unknown["latest.yml"].replace(
      `vector-desktop-${version}-win.exe`,
      `vector-desktop-${version}-unknown.exe`,
    )
    expect(() =>
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: unknown }),
    ).toThrow("references unknown updater asset")

    const duplicate = updaterMetadata()
    const windows = updateAssetsByName.get(`vector-desktop-${version}-win.exe`)
    if (!windows) throw new Error("Missing test Windows updater")
    duplicate["latest.yml"] +=
      `\n  - url: ${windows.sourceName}\n    sha512: ${windows.sha512}\n    size: ${windows.size}\n`
    expect(() =>
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: duplicate }),
    ).toThrow("Duplicate updater metadata URL")

    const missing = updaterMetadata()
    const macDmg = updateAssetsByName.get(`vector-desktop-${version}-mac-arm64.dmg`)
    if (!macDmg) throw new Error("Missing test macOS updater")
    missing["latest-mac.yml"] = missing["latest-mac.yml"].replace(
      `  - url: ${macDmg.sourceName}\n    sha512: ${macDmg.sha512}\n    size: ${macDmg.size}\n`,
      "",
    )
    expect(() =>
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: missing }),
    ).toThrow(`has no entry for ${macDmg.sourceName}`)

    const blockmap = updaterMetadata()
    const macBlockmap = updateAssetsByName.get(`vector-desktop-${version}-mac-arm64.dmg.blockmap`)
    if (!macBlockmap) throw new Error("Missing test macOS blockmap")
    blockmap["latest-mac.yml"] +=
      `\n  - url: ${macBlockmap.sourceName}\n    sha512: ${macBlockmap.sha512}\n    size: ${macBlockmap.size}\n`
    expect(() =>
      validateDesktopRelease({ version, installers, updateAssets, checksums, updaterMetadata: blockmap }),
    ).toThrow("references unknown updater asset")
  })

  test("requires exactly one installer for each target", () => {
    expect(() =>
      validateDesktopRelease({
        version,
        installers: installers.slice(1),
        updateAssets,
        checksums,
        updaterMetadata: updaterMetadata(),
      }),
    ).toThrow("Expected 6 desktop installers, got 5")
  })
})

describe("desktop release checksums", () => {
  test("parses sha256sum output and normalizes hashes", () => {
    expect(parseDesktopReleaseChecksums(`${"A".repeat(64)}  first.dmg\n${"b".repeat(64)} *second.exe\n`)).toEqual({
      "first.dmg": "a".repeat(64),
      "second.exe": "b".repeat(64),
    })
  })

  test("rejects malformed and duplicate entries", () => {
    expect(() => parseDesktopReleaseChecksums("not-a-checksum first.dmg")).toThrow("Invalid checksums.txt entry")
    expect(() => parseDesktopReleaseChecksums(`${"a".repeat(64)}  first.dmg\n${"b".repeat(64)}  first.dmg`)).toThrow(
      "Duplicate checksums.txt entry",
    )
  })
})

describe("immutable desktop release bytes", () => {
  const expected = {
    size: 10,
    sha256: "a".repeat(64),
    sha512: Buffer.alloc(64, 1).toString("base64"),
  }

  test("accepts an identical staged object", () => {
    expect(validateDesktopReleaseAssetBytes("release.bin", expected, expected)).toBeUndefined()
  })

  test.each([
    { ...expected, size: 11 },
    { ...expected, sha256: "b".repeat(64) },
    { ...expected, sha512: Buffer.alloc(64, 2).toString("base64") },
  ])("rejects corrupt staged bytes", (actual) => {
    expect(() => validateDesktopReleaseAssetBytes("release.bin", actual, expected)).toThrow(
      "does not match validated bytes",
    )
  })
})

describe("desktop download manifest", () => {
  test("records all six immutable targets in the stable schema", () => {
    const destinations = manifestDestinations()
    const manifest = createDesktopDownloadManifest({
      version,
      channel: "latest",
      publishedAt: "2026-08-28T00:00:00.000Z",
      installers,
      destinations,
    })

    expect(manifest).toEqual({
      schemaVersion: 1,
      version,
      channel: "latest",
      publishedAt: "2026-08-28T00:00:00.000Z",
      targets: Object.fromEntries(
        installers.map((installer) => [
          installer.target,
          {
            filename: installer.filename,
            pathname: destinations[installer.target].pathname,
            url: destinations[installer.target].url,
            size: installer.size,
            sha256: installer.sha256,
            verification: "release-workflow",
          },
        ]),
      ),
    })
    expect(versionedDesktopDownloadManifestPath(version)).toBe(`releases/vector-v${version}/downloads.json`)
    expect(latestDesktopDownloadManifestPath).toBe("releases/vector-downloads/latest.json")
  })

  test("parses a complete immutable manifest for stable and beta channels", () => {
    for (const channel of ["latest", "beta"] as const) {
      const manifest = createDesktopDownloadManifest({
        version,
        channel,
        publishedAt: "2026-08-28T00:00:00.000Z",
        installers,
        destinations: manifestDestinations(),
      })
      expect(parseDesktopDownloadManifest(manifest, { version, channel })).toEqual(manifest)
    }
  })

  test("rejects stale, incomplete, or redirected immutable manifests", () => {
    const manifest = createDesktopDownloadManifest({
      version,
      channel: "latest",
      publishedAt: "2026-08-28T00:00:00.000Z",
      installers,
      destinations: manifestDestinations(),
    })
    expect(() => parseDesktopDownloadManifest(manifest, { version: "1.19.99", channel: "latest" })).toThrow(
      "version mismatch",
    )
    expect(() => parseDesktopDownloadManifest(manifest, { version, channel: "beta" })).toThrow("channel mismatch")

    const missing = structuredClone(manifest)
    delete missing.targets["linux-arm64"]
    expect(() => parseDesktopDownloadManifest(missing, { version, channel: "latest" })).toThrow(
      "does not contain exactly six targets",
    )

    const redirected = structuredClone(manifest)
    redirected.targets["mac-arm64"].url = "https://example.com/vector-desktop-mac-arm64.dmg"
    expect(() => parseDesktopDownloadManifest(redirected, { version, channel: "latest" })).toThrow(
      "target URL is invalid",
    )
  })

  test.each([
    `https://user@vector-test.public.blob.vercel-storage.com/releases/vector-v${version}/vector-desktop-mac-arm64.dmg`,
    `https://vector-test.public.blob.vercel-storage.com:443/releases/vector-v${version}/vector-desktop-mac-arm64.dmg`,
    `https://vector-test.public.blob.vercel-storage.com/releases/vector-v${version}/vector-desktop-mac-arm64.dmg?x=1`,
    `https://vector-test.public.blob.vercel-storage.com/releases/vector-v${version}/vector-desktop-mac-arm64.dmg#x`,
    `https://vector-test.public.blob.vercel-storage.com/releases/vector-v${version}/%76ector-desktop-mac-arm64.dmg`,
  ])("rejects non-canonical Blob target URL: %s", (url) => {
    const manifest = createDesktopDownloadManifest({
      version,
      channel: "latest",
      publishedAt: "2026-08-28T00:00:00.000Z",
      installers,
      destinations: manifestDestinations(),
    })
    manifest.targets["mac-arm64"].url = url
    expect(() => parseDesktopDownloadManifest(manifest, { version, channel: "latest" })).toThrow(
      "target URL is invalid",
    )
  })

  test("rejects manifests whose targets span Blob origins", () => {
    const manifest = createDesktopDownloadManifest({
      version,
      channel: "latest",
      publishedAt: "2026-08-28T00:00:00.000Z",
      installers,
      destinations: manifestDestinations(),
    })
    manifest.targets["mac-arm64"].url = manifest.targets["mac-arm64"].url.replace("vector-test", "other-store")
    expect(() => parseDesktopDownloadManifest(manifest, { version, channel: "latest" })).toThrow(
      "exactly one Blob origin",
    )
  })
})

describe("desktop release integrity manifest", () => {
  test("records and parses every immutable updater payload", () => {
    const destinations = Object.fromEntries(
      updateAssets.map((entry) => {
        const pathname = versionedDesktopUpdaterPath(version, entry.sourceName)
        return [entry.sourceName, { pathname, url: `https://vector-test.public.blob.vercel-storage.com/${pathname}` }]
      }),
    )
    const manifest = createDesktopReleaseIntegrityManifest({
      version,
      channel: "latest",
      assets: updateAssets,
      destinations,
    })
    expect(parseDesktopReleaseIntegrityManifest(manifest, { version, channel: "latest" })).toEqual(manifest)
    expect(versionedDesktopReleaseIntegrityPath(version)).toBe(`releases/vector-v${version}/integrity.json`)
  })

  test("rejects corruption and mixed origins", () => {
    const destinations = Object.fromEntries(
      updateAssets.map((entry) => {
        const pathname = versionedDesktopUpdaterPath(version, entry.sourceName)
        return [entry.sourceName, { pathname, url: `https://vector-test.public.blob.vercel-storage.com/${pathname}` }]
      }),
    )
    const manifest = createDesktopReleaseIntegrityManifest({
      version,
      channel: "latest",
      assets: updateAssets,
      destinations,
    })
    manifest.assets[updateAssets[0].sourceName].sha512 = "invalid"
    expect(() => parseDesktopReleaseIntegrityManifest(manifest, { version, channel: "latest" })).toThrow(
      "sha512 is invalid",
    )

    const mixed = createDesktopReleaseIntegrityManifest({
      version,
      channel: "latest",
      assets: updateAssets,
      destinations,
    })
    mixed.assets[updateAssets[0].sourceName].url = mixed.assets[updateAssets[0].sourceName].url.replace(
      "vector-test",
      "other-store",
    )
    expect(() => parseDesktopReleaseIntegrityManifest(mixed, { version, channel: "latest" })).toThrow(
      "exactly one Blob origin",
    )
  })
})

describe("desktop release phase", () => {
  test("defaults to all and accepts each explicit phase", () => {
    expect(desktopReleasePhase(undefined)).toBe("all")
    expect(desktopReleasePhase("stage")).toBe("stage")
    expect(desktopReleasePhase("commit")).toBe("commit")
    expect(desktopReleasePhase("all")).toBe("all")
  })

  test("rejects an unknown phase", () => {
    expect(() => desktopReleasePhase("publish")).toThrow("must be stage, commit, or all")
  })
})

function manifestDestinations() {
  return Object.fromEntries(
    installers.map((installer) => [
      installer.target,
      {
        pathname: `releases/vector-v${version}/${installer.filename}`,
        url: `https://vector-test.public.blob.vercel-storage.com/releases/vector-v${version}/${installer.filename}`,
      },
    ]),
  )
}
