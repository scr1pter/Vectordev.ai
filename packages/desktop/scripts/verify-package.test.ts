import { describe, expect, test } from "bun:test"
import { buildIdentityPath, checkPackagedApp, checkUpdaterMetadata, updaterMetadataPath } from "./verify-package"

const good = `provider: generic
url: https://example.public.blob.vercel-storage.com/releases/vector-updates
updaterCacheDirName: vector-desktop-updater
`

describe("verifying a packaged app can self-update", () => {
  test("a --dir build is rejected", () => {
    // The 1.19.96 regression: packaged, launchable, and every update check
    // failed with ENOENT on app-update.yml.
    const result = checkUpdaterMetadata({ present: false })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain("--dir")
  })

  test("a real target with a feed is accepted", () => {
    expect(checkUpdaterMetadata({ present: true, contents: good })).toEqual({ ok: true })
  })

  test("a file without a feed url is rejected", () => {
    const result = checkUpdaterMetadata({ present: true, contents: "provider: generic\n" })
    expect(result.ok).toBe(false)
  })

  test("a non-https feed is rejected", () => {
    const result = checkUpdaterMetadata({
      present: true,
      contents: "provider: generic\nurl: http://example.com/releases\n",
    })
    expect(result.ok).toBe(false)
  })

  test("the metadata lives where electron-updater looks for it", () => {
    expect(updaterMetadataPath("/Applications/Vector.app")).toBe(
      "/Applications/Vector.app/Contents/Resources/app-update.yml",
    )
    expect(buildIdentityPath("/Applications/Vector.app")).toBe(
      "/Applications/Vector.app/Contents/Resources/vector-build.json",
    )
  })

  test("rejects the production shell around dev-compiled output", () => {
    const result = checkPackagedApp({
      bundleID: "ai.vector.app",
      version: "1.19.99",
      buildIdentity: {
        present: true,
        contents: JSON.stringify({ schemaVersion: 1, channel: "dev", version: "1.19.99" }),
      },
      updaterMetadata: { present: true, contents: good },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain("mixed-channel")
  })

  test("accepts a production package built and configured as production", () => {
    expect(
      checkPackagedApp({
        bundleID: "ai.vector.app",
        version: "1.19.99",
        buildIdentity: {
          present: true,
          contents: JSON.stringify({ schemaVersion: 1, channel: "prod", version: "1.19.99" }),
        },
        updaterMetadata: { present: true, contents: good },
      }),
    ).toEqual({ ok: true })
  })

  test("rejects a production package pointed at the beta feed", () => {
    const result = checkPackagedApp({
      bundleID: "ai.vector.app",
      version: "1.19.99",
      buildIdentity: {
        present: true,
        contents: JSON.stringify({ schemaVersion: 1, channel: "prod", version: "1.19.99" }),
      },
      updaterMetadata: {
        present: true,
        contents: "provider: generic\nurl: https://example.com/releases/vector-beta-updates\n",
      },
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.problem).toContain("wrong update feed")
  })

  test("allows a development package only without a release feed", () => {
    expect(
      checkPackagedApp({
        bundleID: "ai.vector.app.dev",
        version: "1.19.99",
        buildIdentity: {
          present: true,
          contents: JSON.stringify({ schemaVersion: 1, channel: "dev", version: "1.19.99" }),
        },
        updaterMetadata: { present: false },
      }),
    ).toEqual({ ok: true })
  })
})
