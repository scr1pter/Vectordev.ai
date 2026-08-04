import { describe, expect, test } from "bun:test"
import { extractLatestVelReply, extractVelReply } from "./vel-call"

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
})
