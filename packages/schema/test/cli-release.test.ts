import { describe, expect, test } from "bun:test"
import { CliRelease } from "../src/cli-release"

const manifest = () => ({
  schemaVersion: 1,
  version: "1.2.3",
  channel: "latest",
  publishedAt: "2026-09-25T00:00:00.000Z",
  sourceRevision: "a".repeat(40),
  catalogSha256: "b".repeat(64),
  targets: Object.fromEntries(
    CliRelease.targets.map((target) => [
      target,
      {
        filename: CliRelease.filename(target),
        pathname: CliRelease.archivePath("1.2.3", target),
        url: `https://fixture.public.blob.vercel-storage.com/${CliRelease.archivePath("1.2.3", target)}`,
        size: 123,
        sha256: "c".repeat(64),
      },
    ]),
  ),
})

describe("CLI releases", () => {
  test("complete pinned manifests give shell-safe metadata for every native target", () => {
    const value = CliRelease.decode(manifest(), "https://fixture.public.blob.vercel-storage.com")
    expect(Object.keys(value.targets)).toHaveLength(12)
    for (const target of CliRelease.targets) {
      const selected = CliRelease.select(value, target)
      expect(CliRelease.tsv(selected)).toBe(`1.2.3\t${target}\t${selected.url}\t123\t${"c".repeat(64)}\n`)
    }
    expect(CliRelease.manifestPath()).toBe("releases/vector-cli/latest.json")
    expect(CliRelease.manifestPath("beta")).toBe("releases/vector-cli/beta.json")
    expect(CliRelease.manifestPath("1.2.3")).toBe("releases/vector-cli/v1.2.3/manifest.json")
  })

  test("rejects incomplete releases, foreign Blob tenants and altered archive identities", () => {
    expect(() => CliRelease.decode(manifest(), "https://other.public.blob.vercel-storage.com")).toThrow()
    for (const change of [
      { size: 0 },
      { size: 1.5 },
      { size: CliRelease.MAX_ARCHIVE_BYTES + 1 },
      { sha256: "invalid" },
      { filename: "wrong.tar.gz" },
      { pathname: "releases/latest.tar.gz" },
      { url: "https://example.com/vector.tar.gz" },
      { url: manifest().targets["darwin-arm64"]!.url + "?token=fixture" },
      { url: manifest().targets["darwin-arm64"]!.url.replace("fixture.", "other.") },
      { url: manifest().targets["darwin-arm64"]!.url.replace("https://", "https://user@") },
    ]) {
      const value = manifest()
      Object.assign(value.targets["darwin-arm64"]!, change)
      expect(() => CliRelease.decode(value)).toThrow()
    }
    const missing = manifest()
    delete missing.targets["linux-arm64-musl"]
    expect(() => CliRelease.decode(missing)).toThrow()
    expect(() => CliRelease.decode({ ...manifest(), version: "1.2.3-beta.1" })).toThrow()
    expect(() => CliRelease.decode({ ...manifest(), publishedAt: "invalid" })).toThrow()
    expect(() => CliRelease.decode({ ...manifest(), unexpected: true })).toThrow()
    for (const version of ["../../x", "v1.2.3", "1.2.3\nmalicious", "1.2.3+build", "1.2.3-..x"])
      expect(() => CliRelease.manifestPath(version)).toThrow()
  })
})
