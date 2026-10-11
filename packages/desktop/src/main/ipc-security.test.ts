import { describe, expect, test } from "bun:test"
import { isTrustedRendererEvent } from "./trusted-renderer"

const event = (url: string, topLevel = "vector://renderer/index.html") =>
  ({
    sender: {
      isDestroyed: () => false,
      getURL: () => topLevel,
    },
    senderFrame: { url },
  }) as never

describe("trusted renderer IPC", () => {
  test("rejects WSL requests sent by an untrusted child frame", () => {
    const trusted = isTrustedRendererEvent(event("https://attacker.example"), {
      windowFor: () => ({}),
      trustedUrl: (url) => url === "vector://renderer/index.html",
    })

    expect(trusted).toBe(false)
  })

  test("accepts the trusted renderer frame", () => {
    const trusted = isTrustedRendererEvent(event("vector://renderer/index.html"), {
      windowFor: () => ({}),
      trustedUrl: (url) => url === "vector://renderer/index.html",
    })

    expect(trusted).toBe(true)
  })
})
