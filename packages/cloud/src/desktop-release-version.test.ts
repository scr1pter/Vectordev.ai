import { describe, expect, test } from "bun:test"
import { desktopReleaseVersion } from "./desktop-release-version"

describe("desktop release version", () => {
  test.each(["1.2", "v1.2", "1.2.0", "v1.2.0", "1.2.x", "1.2.0-beta.1", "v1.2.99+build"])(
    "rejects the reserved release line: %s",
    (version) => {
      expect(() => desktopReleaseVersion(version)).toThrow("The 1.2 release line is reserved")
    },
  )

  test("accepts stable and beta Vector releases", () => {
    expect(desktopReleaseVersion("v1.19.97")).toBe("1.19.97")
    expect(desktopReleaseVersion("1.19.98-beta.0")).toBe("1.19.98-beta.0")
    expect(desktopReleaseVersion("v2.0.0-beta.12")).toBe("2.0.0-beta.12")
  })

  test.each([
    undefined,
    "",
    "1",
    "1.19",
    "01.19.97",
    "1.019.97",
    "1.19.097",
    "1.19.97-rc.1",
    "1.19.97-beta",
    "1.19.97-beta.01",
    "1.19.97+build",
    "V1.19.97",
    " 1.19.97",
  ])("rejects an invalid release version: %s", (version) => {
    expect(() => desktopReleaseVersion(version)).toThrow()
  })
})
