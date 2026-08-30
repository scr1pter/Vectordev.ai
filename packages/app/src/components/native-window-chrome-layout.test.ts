import { describe, expect, test } from "bun:test"
import { nativeWindowChromeLayout } from "./native-window-chrome-layout"

describe("native window chrome", () => {
  test("leaves web, native-framed Linux, and legacy layouts unchanged", () => {
    expect(nativeWindowChromeLayout({ enabled: true, platform: "web", os: "macos" })).toBeUndefined()
    expect(nativeWindowChromeLayout({ enabled: true, platform: "desktop", os: "linux" })).toBeUndefined()
    expect(nativeWindowChromeLayout({ enabled: false, platform: "desktop", os: "windows" })).toBeUndefined()
  })

  test("reserves macOS traffic lights independently of sidebar visibility", () => {
    expect(nativeWindowChromeLayout({ enabled: true, platform: "desktop", os: "macos" })).toEqual({
      os: "macos",
      height: 40,
      left: 84,
      right: 0,
    })
  })

  test("reserves Windows native caption buttons", () => {
    expect(nativeWindowChromeLayout({ enabled: true, platform: "desktop", os: "windows" })).toEqual({
      os: "windows",
      height: 40,
      left: 0,
      right: 138,
    })
  })

  test.each([0.5, 1, 1.5, 2])("matches native control dimensions at zoom %s", (zoom) => {
    const mac = nativeWindowChromeLayout({ enabled: true, platform: "desktop", os: "macos", zoom })!
    const windows = nativeWindowChromeLayout({ enabled: true, platform: "desktop", os: "windows", zoom })!
    expect(mac.height * zoom).toBe(40)
    expect(mac.left * zoom).toBe(84)
    expect(windows.height * zoom).toBe(Math.max(40, 40 * zoom))
    expect(windows.right * zoom).toBe(138)
  })

  test.each([0, -1, NaN, Infinity])("invalid zoom %s cannot erase chrome", (zoom) => {
    expect(nativeWindowChromeLayout({ enabled: true, platform: "desktop", os: "windows", zoom })?.height).toBe(40)
  })
})
