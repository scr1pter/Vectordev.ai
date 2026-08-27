import { describe, expect, test } from "bun:test"
import { desktopReleaseVersion } from "./desktop-release-version"

describe("desktop release version", () => {
  test.each(["1.2", "v1.2", "1.2.0", "v1.2.0", "1.2.x"])(
    "rejects the reserved release line: %s",
    (version) => {
      expect(() => desktopReleaseVersion(version)).toThrow("The 1.2 release line is reserved")
    },
  )

  test("accepts the current Vector release", () => {
    expect(desktopReleaseVersion("v1.19.96")).toBe("1.19.96")
  })
})
