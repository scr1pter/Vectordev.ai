import { describe, expect, test } from "bun:test"
import { CredentialFocusChangedError, sendGuardedCharacters, type GuardedInputEvent } from "./browser-credential-input"

describe("trusted browser typing", () => {
  test("stops before a character when keydown moves focus to a credential field", async () => {
    const events: GuardedInputEvent[] = []
    let credentialFocused = false
    const result = sendGuardedCharacters(
      "ab",
      async () => credentialFocused,
      (event) => {
        events.push(event)
        if (event.type === "keyDown") credentialFocused = true
      },
    )

    await expect(result).rejects.toBeInstanceOf(CredentialFocusChangedError)
    expect(events).toEqual([{ type: "keyDown", keyCode: "a", modifiers: [] }])
  })

  test("sends every event when focus remains on an ordinary field", async () => {
    const events: GuardedInputEvent[] = []
    await sendGuardedCharacters(
      "A",
      async () => false,
      (event) => events.push(event),
    )
    expect(events).toEqual([
      { type: "keyDown", keyCode: "A", modifiers: ["shift"] },
      { type: "char", keyCode: "A", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "A", modifiers: ["shift"] },
    ])
  })
})
