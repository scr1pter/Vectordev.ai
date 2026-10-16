import { describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "./cors"

describe("browser origin policy", () => {
  test("accepts exact local renderer and loopback origins", () => {
    expect(isAllowedCorsOrigin("oc://renderer")).toBe(true)
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://127.0.0.1:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://[::1]:3000")).toBe(true)
  })

  test.each([
    "oc://renderer.attacker.example",
    "http://localhost:3000@attacker.example",
    "http://127.0.0.1:3000@attacker.example",
    "https://attacker.vectordev.ai",
    "null",
  ])("rejects untrusted origin %s", (origin) => {
    expect(isAllowedCorsOrigin(origin)).toBe(false)
  })

  test("trusts no website by default, Vector's own included, only explicitly configured origins", () => {
    expect(isAllowedCorsOrigin("https://vectordev.ai")).toBe(false)
    expect(isAllowedCorsOrigin("https://vectordev.ai", { cors: ["https://vectordev.ai"] })).toBe(true)
    expect(isAllowedCorsOrigin("https://custom.example", { cors: ["https://custom.example"] })).toBe(true)
    expect(isAllowedCorsOrigin("https://custom.example.attacker.example", { cors: ["https://custom.example"] })).toBe(
      false,
    )
  })

  test("accepts same-host web requests and clients without Origin", () => {
    expect(isAllowedRequestOrigin("https://vector.example", "vector.example")).toBe(true)
    expect(isAllowedRequestOrigin(undefined, "localhost:4096")).toBe(true)
    expect(isAllowedRequestOrigin("https://attacker.example", "vector.example")).toBe(false)
    expect(isAllowedRequestOrigin("file://vector.example", "vector.example")).toBe(false)
  })
})
