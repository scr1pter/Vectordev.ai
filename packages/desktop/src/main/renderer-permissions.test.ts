import { describe, expect, test } from "bun:test"
import { allowsRendererPermission, allowsRendererPermissionRequest } from "./renderer-permissions"

describe("renderer permissions", () => {
  test("keeps the existing passive permissions available", () => {
    expect(allowsRendererPermission("notifications")).toBe(true)
    expect(allowsRendererPermission("clipboard-sanitized-write")).toBe(true)
  })

  test("allows microphone-only media access", () => {
    expect(allowsRendererPermission("media", "audio")).toBe(true)
    expect(allowsRendererPermissionRequest("media", ["audio"])).toBe(true)
  })

  test("rejects camera, mixed media, and unrelated permissions", () => {
    expect(allowsRendererPermission("media", "video")).toBe(false)
    expect(allowsRendererPermission("media", "unknown")).toBe(false)
    expect(allowsRendererPermissionRequest("media", ["video"])).toBe(false)
    expect(allowsRendererPermissionRequest("media", ["audio", "video"])).toBe(false)
    expect(allowsRendererPermissionRequest("geolocation")).toBe(false)
  })
})
