import { describe, expect, test } from "bun:test"
import { browserOrigin, isAllowedBrowserNavigation, isLocalBrowserUrl } from "./browser-navigation-policy"

describe("browser navigation policy", () => {
  test("allows only loopback URLs without external-site approval", () => {
    expect(isLocalBrowserUrl("http://localhost:3000/path")).toBe(true)
    expect(isLocalBrowserUrl("https://app.localhost/test")).toBe(true)
    expect(isLocalBrowserUrl("http://127.0.0.1:4173")).toBe(true)
    expect(isLocalBrowserUrl("http://[::1]:8080")).toBe(true)
    expect(isLocalBrowserUrl("ftp://localhost/file")).toBe(false)
  })

  test("treats private-network hosts as external", () => {
    expect(isLocalBrowserUrl("http://10.0.0.2")).toBe(false)
    expect(isLocalBrowserUrl("http://172.16.0.2")).toBe(false)
    expect(isLocalBrowserUrl("http://192.168.1.2")).toBe(false)
  })

  test("keeps an approval scoped to its exact external origin", () => {
    const allowed = new Set(["https://example.com"])
    expect(isAllowedBrowserNavigation("https://example.com/docs", allowed)).toBe(true)
    expect(isAllowedBrowserNavigation("https://accounts.example.com/login", allowed)).toBe(false)
    expect(isAllowedBrowserNavigation("https://example.net", allowed)).toBe(false)
    expect(browserOrigin("javascript:alert(1)")).toBeUndefined()
  })
})
