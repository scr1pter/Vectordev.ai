import { describe, expect, test } from "bun:test"
import { extractLatestVelReply, extractVelReply, prepareVelSpeech } from "./vel-call"
import { isVelVoiceTurn, VEL_VOICE_SYSTEM } from "./vel-message"

describe("Vel agent replies", () => {
  test("speaks assistant text instead of tool output", () => {
    expect(
      extractVelReply({
        info: { role: "assistant" },
        parts: [
          { type: "tool", output: "npm install output" },
          { type: "text", text: "I built the requested screen and verified it." },
        ],
      }),
    ).toBe("I built the requested screen and verified it.")
  })

  test("recovers the newest completed assistant reply from session history", () => {
    expect(
      extractLatestVelReply([
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Older response" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "Build the app" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "The app is built and tested." }] },
      ]),
    ).toBe("The app is built and tested.")
  })

  test("marks only voice-originated turns for timeline styling", () => {
    expect(isVelVoiceTurn(VEL_VOICE_SYSTEM)).toBe(true)
    expect(isVelVoiceTurn("Answer this typed request normally.")).toBe(false)
    expect(isVelVoiceTurn(undefined)).toBe(false)
  })

  test("reads the active agent reply without replacing code work with canned narration", () => {
    expect(prepareVelSpeech("Done.\n```ts\nconst ready = true\n```")).toBe("Done. const ready = true")
    expect(VEL_VOICE_SYSTEM.toLowerCase()).not.toContain("handing")
    expect(VEL_VOICE_SYSTEM.toLowerCase()).not.toContain("hand off")
  })
})
