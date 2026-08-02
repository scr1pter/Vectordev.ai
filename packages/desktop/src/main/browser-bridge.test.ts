import { describe, expect, test } from "bun:test"
import { parseBrowserAgentInput } from "./browser-bridge-input"

describe("browser bridge input", () => {
  test("accepts a bounded engine command", () => {
    expect(parseBrowserAgentInput({ contextId: "session-1", command: "click", selector: "#submit" })).toEqual({
      contextId: "session-1",
      command: "click",
      selector: "#submit",
      url: undefined,
      text: undefined,
      key: undefined,
      credentialId: undefined,
      allowExternal: undefined,
      visible: undefined,
      milliseconds: undefined,
      deltaY: undefined,
    })
  })

  test("rejects unknown commands and oversized context ids", () => {
    expect(() => parseBrowserAgentInput({ contextId: "session-1", command: "executeJavaScript" })).toThrow()
    expect(() => parseBrowserAgentInput({ contextId: "x".repeat(300), command: "observe" })).toThrow()
  })
})
