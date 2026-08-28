import { describe, expect, test } from "bun:test"
import {
  checksumsFromManifest,
  contentTypeFor,
  DOWNLOAD_MENU,
  installerFromManifest,
  installerFor,
  parseDownloadManifest,
  parseDownloadManifestJson,
  PUBLIC_DOWNLOAD_TARGETS,
  suggestedTarget,
} from "../api/_lib/downloads"
import { downloadTargets } from "../api/_lib/billing"
import { currentInstaller } from "../api/_lib/release-downloads"

describe("public installer downloads", () => {
  test("every advertised platform resolves to a real installer", () => {
    for (const entry of DOWNLOAD_MENU) {
      expect(() => installerFor(entry.target)).not.toThrow()
    }
  })

  test("the public list matches what the licensed endpoint serves", () => {
    // The same files. If these drift, a customer and a visitor get different
    // builds from the same release, which is the worst kind of bug to debug.
    expect(PUBLIC_DOWNLOAD_TARGETS).toEqual(downloadTargets)
  })

  test("an unknown or missing target is refused, not guessed", () => {
    expect(() => installerFor("mac-m5")).toThrow(/does not exist/i)
    expect(() => installerFor(undefined)).toThrow(/does not exist/i)
    expect(() => installerFor("../../etc/passwd")).toThrow(/does not exist/i)
  })

  test("rejects an unknown target before reading release storage", async () => {
    await expect(currentInstaller("mac-m5")).rejects.toMatchObject({ code: "DOWNLOAD_NOT_FOUND" })
  })
})

describe("choosing a build from the user agent", () => {
  const ua = {
    macIntel: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140",
    win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140",
    winArm: "Mozilla/5.0 (Windows NT 10.0; Win64; ARM64) AppleWebKit/537.36 Chrome/140",
    linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140",
    linuxArm: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/140",
  }

  test("apple silicon is the default for every Mac", () => {
    // Safari and Chrome on Apple silicon still report "Intel Mac OS X", so the
    // UA cannot distinguish them. An Intel Mac given the arm64 build fails
    // loudly; Apple silicon given the Intel build silently runs slower forever.
    expect(suggestedTarget(ua.macIntel)).toBe("mac-arm64")
  })

  test("windows and linux pick the right architecture", () => {
    expect(suggestedTarget(ua.win)).toBe("windows-x64")
    expect(suggestedTarget(ua.winArm)).toBe("windows-arm64")
    expect(suggestedTarget(ua.linux)).toBe("linux-x64")
    expect(suggestedTarget(ua.linuxArm)).toBe("linux-arm64")
  })

  test("an unknown or absent user agent still yields a downloadable build", () => {
    // The button must never be a dead end, so this always resolves.
    for (const value of [undefined, "", "curl/8.4.0", "Googlebot"]) {
      expect(() => installerFor(suggestedTarget(value))).not.toThrow()
    }
  })
})

describe("content types", () => {
  test("each installer is served as its own type", () => {
    expect(contentTypeFor("a.dmg")).toContain("apple")
    expect(contentTypeFor("a.exe")).toContain("executable")
    expect(contentTypeFor("a.AppImage")).toContain("executable")
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream")
  })
})

describe("atomic desktop release manifest", () => {
  const version = "1.19.98"
  const targets = Object.fromEntries(
    Object.entries(PUBLIC_DOWNLOAD_TARGETS).map(([target, filename]) => [
      target,
      {
        filename,
        pathname: `releases/vector-v${version}/${filename}`,
        url: `https://vector.public.blob.vercel-storage.com/releases/vector-v${version}/${filename}`,
        size: 123_456,
        sha256: "a".repeat(64),
        verification: "release-workflow",
      },
    ]),
  )
  const manifest = {
    schemaVersion: 1,
    version,
    channel: "latest",
    publishedAt: "2026-08-28T12:00:00.000Z",
    targets,
  }

  test("accepts one complete immutable release", () => {
    const parsed = parseDownloadManifest(manifest)
    expect(parsed.version).toBe(version)
    expect(installerFromManifest(parsed, "windows-arm64").filename).toBe("vector-desktop-win-arm64.exe")
    expect(checksumsFromManifest(parsed)).toBe(
      `https://vector.public.blob.vercel-storage.com/releases/vector-v${version}/checksums.txt`,
    )
  })

  test("rejects missing, mixed-version and untrusted installer entries", () => {
    const missing = structuredClone(manifest)
    delete missing.targets["linux-arm64"]
    expect(() => parseDownloadManifest(missing)).toThrow(/incomplete/i)

    const mixed = structuredClone(manifest)
    mixed.targets["mac-arm64"].pathname = "releases/vector-v1.17.45/vector-desktop-mac-arm64.dmg"
    expect(() => parseDownloadManifest(mixed)).toThrow(/mac-arm64 installer entry/i)

    const untrusted = structuredClone(manifest)
    untrusted.targets["mac-arm64"].url = "https://example.com/vector-desktop-mac-arm64.dmg"
    expect(() => parseDownloadManifest(untrusted)).toThrow(/installer URL/i)

    const mixedOrigin = structuredClone(manifest)
    mixedOrigin.targets["mac-arm64"].url = mixedOrigin.targets["mac-arm64"].url.replace(
      "vector.public",
      "another.public",
    )
    expect(() => parseDownloadManifest(mixedOrigin)).toThrow(/mixes storage origins/i)

    const decorated = structuredClone(manifest)
    decorated.targets["mac-arm64"].url += "?download=latest#installer"
    expect(() => parseDownloadManifest(decorated)).toThrow(/installer URL/i)
  })

  test("ties every installer to the store that supplied the manifest", () => {
    expect(() => parseDownloadManifest(manifest, "https://other.public.blob.vercel-storage.com")).toThrow(
      /mixes storage origins/i,
    )
  })

  test("rejects malformed manifest JSON as a release error", () => {
    expect(() => parseDownloadManifestJson("{")).toThrow(/not valid JSON/i)
  })
})
