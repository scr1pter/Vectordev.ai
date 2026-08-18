import { describe, expect, test } from "bun:test"
import { pausedStatus } from "./scheduled-agents"

const once = { kind: "once", at: "2026-08-20T10:00:00.000Z" } as const
const daily = { kind: "daily", time: "09:00" } as const

describe("pausedStatus — pausing", () => {
  test("parks a pending run", () => {
    expect(pausedStatus({ status: "scheduled", recurrence: once }, true)).toBe("canceled")
  })

  test("leaves every other state untouched", () => {
    for (const status of ["running", "completed", "failed", "canceled"] as const) {
      expect(pausedStatus({ status, recurrence: once }, true)).toBe(status)
    }
  })
})

describe("pausedStatus — resuming", () => {
  test("re-arms a run that pausing had parked", () => {
    expect(pausedStatus({ status: "canceled", recurrence: once }, false)).toBe("scheduled")
  })

  test("does NOT resurrect a finished one-shot run", () => {
    // The bug this guards: resuming used to force "scheduled" unconditionally,
    // so a completed or failed one-shot task ran a second time.
    expect(pausedStatus({ status: "completed", recurrence: once }, false)).toBe("completed")
    expect(pausedStatus({ status: "failed", recurrence: once }, false)).toBe("failed")
  })

  test("does not disturb a run that is currently executing", () => {
    expect(pausedStatus({ status: "running", recurrence: once }, false)).toBe("running")
  })

  test("a one-shot task with no recurrence behaves like an explicit once", () => {
    expect(pausedStatus({ status: "completed", recurrence: undefined }, false)).toBe("completed")
    expect(pausedStatus({ status: "canceled", recurrence: undefined }, false)).toBe("scheduled")
  })

  test("re-arms a recurring task even from a terminal state", () => {
    // A pause straddling a run leaves a recurring task "completed" (the
    // completion handler only reschedules when !paused), so resuming has to
    // put it back on the schedule or the task is silently dead forever.
    expect(pausedStatus({ status: "completed", recurrence: daily }, false)).toBe("scheduled")
    expect(pausedStatus({ status: "failed", recurrence: daily }, false)).toBe("scheduled")
    expect(pausedStatus({ status: "canceled", recurrence: daily }, false)).toBe("scheduled")
  })
})
