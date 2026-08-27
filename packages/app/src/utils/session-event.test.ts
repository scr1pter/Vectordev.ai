import { describe, expect, test } from "bun:test"
import { sessionIDFromEvent } from "./session-event"

describe("sessionIDFromEvent", () => {
  test("reads the session identity from event properties", () => {
    expect(sessionIDFromEvent({ properties: { sessionID: "ses_123" } })).toBe("ses_123")
  })

  test("never treats an SSE event envelope id as a session id", () => {
    expect(sessionIDFromEvent({ id: "evt_123", properties: {} } as { properties: unknown })).toBeUndefined()
  })
})
