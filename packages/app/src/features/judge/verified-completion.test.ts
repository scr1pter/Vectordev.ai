import { describe, expect, test } from "bun:test"
import { completionPolicy, VERIFIED_COMPLETION_POLICY, VERIFIED_COMPLETION_REMINDER } from "./verified-completion"

describe("completionPolicy", () => {
  const judged = { type: "text", text: VERIFIED_COMPLETION_POLICY }
  const plain = { type: "text", text: "fix the parser" }

  test("gives the full policy once, then a reminder", () => {
    expect(completionPolicy([], () => [])).toBe(VERIFIED_COMPLETION_POLICY)
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
    ]
    const parts = (id: string) => (id === "u1" ? [plain, judged] : [])
    expect(completionPolicy(messages, parts)).toBe(VERIFIED_COMPLETION_REMINDER)
    expect(completionPolicy(messages, () => [plain])).toBe(VERIFIED_COMPLETION_POLICY)
  })

  test("gives the full policy again after a compaction", () => {
    const messages = [
      { id: "u1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "a2", role: "assistant", summary: true },
      { id: "u2", role: "user" },
    ]
    expect(completionPolicy(messages, (id) => (id === "u1" ? [judged] : [plain]))).toBe(VERIFIED_COMPLETION_POLICY)
    expect(completionPolicy(messages, () => [judged])).toBe(VERIFIED_COMPLETION_REMINDER)
  })
})
