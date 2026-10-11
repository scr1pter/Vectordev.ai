import { describe, expect, test } from "bun:test"
import { createNotificationEventGate, sessionNotificationAllowed } from "./notification-event-gate"

describe("notification event gate", () => {
  test("admits a completion event only once", () => {
    const admit = createNotificationEventGate()

    expect(admit("event-1")).toBe(true)
    expect(admit("event-1")).toBe(false)
    expect(admit("event-2")).toBe(true)
  })

  test("evicts the oldest event when the limit is reached", () => {
    const admit = createNotificationEventGate(2)

    expect(admit("event-1")).toBe(true)
    expect(admit("event-2")).toBe(true)
    expect(admit("event-3")).toBe(true)
    expect(admit("event-1")).toBe(true)
  })
})

describe("session notification visibility", () => {
  test("a failed reconnect lookup cannot announce an unseen helper error", () => {
    expect(sessionNotificationAllowed("ses_unknown", undefined)).toBe(false)
    expect(sessionNotificationAllowed("ses_helper", { internal: "browser-agent.planner" })).toBe(false)
    expect(sessionNotificationAllowed("ses_legacy", { title: "Vector Tool · Inline edit" })).toBe(false)
    expect(sessionNotificationAllowed("ses_child", { parentID: "ses_task" })).toBe(false)
  })

  test("known top-level session errors and global errors remain visible", () => {
    expect(sessionNotificationAllowed("ses_task", { title: "Fix the login page" })).toBe(true)
    expect(sessionNotificationAllowed(undefined, undefined)).toBe(true)
  })
})
