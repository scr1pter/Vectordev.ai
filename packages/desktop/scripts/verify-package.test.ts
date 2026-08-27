import { describe, expect, test } from "bun:test"
import { checkUpdaterMetadata, updaterMetadataPath } from "./verify-package"

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
  })
})
