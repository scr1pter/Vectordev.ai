import { describe, expect, test } from "bun:test"
import { selectedDownloadTarget } from "./download-target"

const userAgent = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36",
}

describe("download target selection", () => {
  test("a valid explicit target takes precedence over browser detection", () => {
    expect(selectedDownloadTarget("?target=linux-arm64", userAgent.mac).id).toBe("linux-arm64")
    expect(selectedDownloadTarget("?checkout=cancelled&target=mac-x64", userAgent.windows).id).toBe("mac-x64")
  })

  test("an invalid or missing target falls back to browser detection", () => {
    expect(selectedDownloadTarget("?target=../../etc/passwd", userAgent.windows).id).toBe("windows-x64")
    expect(selectedDownloadTarget("?target=", userAgent.linuxArm).id).toBe("linux-arm64")
    expect(selectedDownloadTarget("", userAgent.mac).id).toBe("mac-arm64")
  })
})
