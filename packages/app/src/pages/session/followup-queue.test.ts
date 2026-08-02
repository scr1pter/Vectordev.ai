import { describe, expect, test } from "bun:test"
import { enqueueSessionFollowup, SESSION_FOLLOWUP_LIMIT } from "./followup-queue"

describe("session follow-up queue", () => {
  test("accepts messages until the per-task limit", () => {
    const items = Array.from({ length: SESSION_FOLLOWUP_LIMIT - 1 }, (_, index) => index)

    expect(enqueueSessionFollowup(items, SESSION_FOLLOWUP_LIMIT - 1)).toHaveLength(SESSION_FOLLOWUP_LIMIT)
  })

  test("rejects a twenty-first queued message", () => {
    const items = Array.from({ length: SESSION_FOLLOWUP_LIMIT }, (_, index) => index)

    expect(enqueueSessionFollowup(items, SESSION_FOLLOWUP_LIMIT)).toBeUndefined()
  })
})
