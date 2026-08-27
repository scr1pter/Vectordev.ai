import { describe, expect, test } from "bun:test"
import { isLocalBrowserUrl, normalizeBrowserUrl } from "./types"

describe("browser agent URLs", () => {
  test("normalizes host input and recognizes loopback pages", () => {
    expect(normalizeBrowserUrl("localhost:3000/app")).toBe("http://localhost:3000/app")
    expect(isLocalBrowserUrl("http://localhost:3000/app")).toBe(true)
    expect(isLocalBrowserUrl("https://dev.localhost/app")).toBe(true)
    expect(isLocalBrowserUrl("http://127.0.0.1:4173")).toBe(true)
    expect(isLocalBrowserUrl("http://[::1]:4173")).toBe(true)
  })

  test("requires the external-site gate for LAN and non-http URLs", () => {
    expect(isLocalBrowserUrl("http://10.0.0.5")).toBe(false)
    expect(isLocalBrowserUrl("http://172.20.0.5")).toBe(false)
    expect(isLocalBrowserUrl("http://192.168.1.5")).toBe(false)
    expect(isLocalBrowserUrl("ftp://localhost/file")).toBe(false)
  })
})
