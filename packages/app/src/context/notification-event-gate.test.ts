import { describe, expect, test } from "bun:test"
import { createNotificationEventGate } from "./notification-event-gate"

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
