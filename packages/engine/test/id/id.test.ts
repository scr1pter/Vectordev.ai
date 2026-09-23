import { describe, expect, test } from "bun:test"
import { Identifier } from "@/id/id"

// The encoded timestamp is only 36 bits wide, so it repeats roughly every 795
// days. These pin the recovery either side of the 2026-08-14 rollover, which is
// where tool-output cleanup began deleting the newest files and keeping the
// oldest.
const WRAP_MS = 2 ** 36
const DAY_MS = 24 * 60 * 60 * 1000
const ROLLOVER = Math.floor(1787175643293 / WRAP_MS) * WRAP_MS

describe("Identifier.timestamp", () => {
  test("round-trips an ascending id created before the rollover", () => {
    const now = ROLLOVER - 5 * DAY_MS
    const created = now - 3 * DAY_MS
    expect(Identifier.timestamp(Identifier.create("tool", "ascending", created), now)).toBe(created)
  })

  test("round-trips an ascending id created after the rollover", () => {
    const now = ROLLOVER + 5 * DAY_MS
    const created = now - 3 * DAY_MS
    expect(Identifier.timestamp(Identifier.create("tool", "ascending", created), now)).toBe(created)
  })

  test("recovers an id created before the rollover when read after it", () => {
    const created = ROLLOVER - 2 * DAY_MS
    const now = ROLLOVER + 5 * DAY_MS
    expect(Identifier.timestamp(Identifier.create("tool", "ascending", created), now)).toBe(created)
  })

  test("keeps ordering across the rollover", () => {
    const now = ROLLOVER + 5 * DAY_MS
    const older = Identifier.create("tool", "ascending", ROLLOVER - 10 * DAY_MS)
    const newer = Identifier.create("tool", "ascending", ROLLOVER + DAY_MS)
    expect(Identifier.timestamp(older, now)).toBeLessThan(Identifier.timestamp(newer, now))
  })

  test("a seven-day retention cutoff keeps recent output and drops old output", () => {
    const now = ROLLOVER + 5 * DAY_MS
    const cutoff = Identifier.timestamp(Identifier.create("tool", "ascending", now - 7 * DAY_MS), now)
    const recent = Identifier.timestamp(Identifier.create("tool", "ascending", now - 3 * DAY_MS), now)
    const old = Identifier.timestamp(Identifier.create("tool", "ascending", now - 10 * DAY_MS), now)
    expect(recent).toBeGreaterThanOrEqual(cutoff)
    expect(old).toBeLessThan(cutoff)
  })
})
