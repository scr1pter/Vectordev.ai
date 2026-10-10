import { describe, expect, test } from "bun:test"
import { openExternalUrl, safeExternalUrl, secureExternalAnchor } from "./external-url"

describe("external URL boundary", () => {
  test("allows HTTP(S) and rejects executable or privileged schemes", () => {
    expect(safeExternalUrl("https://example.test/path")).toBe("https://example.test/path")
    expect(safeExternalUrl("http://example.test/path")).toBe("http://example.test/path")
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined()
    expect(safeExternalUrl("data:text/html,bad")).toBeUndefined()
    expect(safeExternalUrl("file:///etc/passwd")).toBeUndefined()
    expect(safeExternalUrl("https://user:secret@example.test")).toBeUndefined()
  })

  test("opens a new context without retaining an opener or referrer", () => {
    const child = { opener: {} }
    const calls: unknown[][] = []
    const opened = openExternalUrl("https://example.test", ((...args: unknown[]) => {
      calls.push(args)
      return child
    }) as typeof window.open)

    expect(opened).toBe(true)
    expect(calls).toEqual([["https://example.test/", "_blank", "noopener,noreferrer"]])
    expect(child.opener).toBeNull()
  })

  test("normalizes external anchors and rejects unsafe schemes", () => {
    const safe = document.createElement("a")
    safe.href = "/docs"
    expect(secureExternalAnchor(safe, "https://app.example.test/session")).toBe(true)
    expect(safe.href).toBe("https://app.example.test/docs")
    expect(safe.target).toBe("_blank")
    expect(safe.rel).toBe("noopener noreferrer")

    const unsafe = document.createElement("a")
    unsafe.href = "javascript:alert(1)"
    expect(secureExternalAnchor(unsafe, "https://app.example.test")).toBe(false)
  })
})
