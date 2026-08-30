import { describe, expect, test } from "bun:test"
import { extractAssistantReply } from "./assistant-reply"

describe("assistant reply extraction", () => {
  test("uses assistant text parts without including tool output", () => {
    expect(
      extractAssistantReply({
        info: { role: "assistant" },
        parts: [
          { type: "tool", output: "npm install output" },
          { type: "text", text: "  The requested change is ready.  " },
        ],
      }),
    ).toBe("The requested change is ready.")
  })

  test("unwraps nested responses and joins text blocks", () => {
    expect(
      extractAssistantReply({ data: { response: { content: [{ type: "text", text: "First" }, "Second"] } } }),
    ).toBe("First\nSecond")
  })

  test("returns no reply for empty or non-text payloads", () => {
    expect(extractAssistantReply(undefined)).toBe("")
    expect(extractAssistantReply({ parts: [{ type: "tool", output: "Done" }] })).toBe("")
  })

  test("bounds traversal of malformed cyclic responses", () => {
    const response: { data?: unknown } = {}
    response.data = response
    expect(extractAssistantReply(response)).toBe("")
  })
})
