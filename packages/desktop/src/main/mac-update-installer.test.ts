import { describe, expect, test } from "bun:test"
import { macAppBundlePath } from "./mac-update-path"

describe("mac update installer", () => {
  test("finds the containing app bundle from the packaged executable", () => {
    expect(macAppBundlePath("/Applications/Vector.app/Contents/MacOS/Vector")).toBe("/Applications/Vector.app")
  })

  test("rejects executables outside an app bundle", () => {
    expect(() => macAppBundlePath("/usr/local/bin/vector")).toThrow("application bundle")
  })
})
