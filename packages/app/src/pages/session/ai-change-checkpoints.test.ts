import { describe, expect, test } from "bun:test"
import { CHECKPOINT_MAX, fitCheckpoints, saveCheckpoints } from "./ai-change-checkpoints"

const checkpoint = (id: number, size = 10) => ({ id: `c${id}`, snapshots: [{ path: "a.ts", content: "x".repeat(size) }] })

function quotaStorage(limit: number) {
  const values = new Map<string, string>()
  return {
    values,
    setItem(key: string, value: string) {
      if (value.length > limit) throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
      values.set(key, value)
    },
  }
}

describe("AI change checkpoint storage", () => {
  test("keeps the newest checkpoints that fit the budget, in order", () => {
    const list = [checkpoint(3, 400), checkpoint(2, 400), checkpoint(1, 400)]
    expect(fitCheckpoints(list, 1_000).map((item) => item.id)).toEqual(["c3", "c2"])
  })

  test("always keeps the newest checkpoint, even when it alone is over budget", () => {
    expect(fitCheckpoints([checkpoint(1, 5_000)], 100).map((item) => item.id)).toEqual(["c1"])
  })

  test("never keeps more than the maximum count", () => {
    const list = Array.from({ length: CHECKPOINT_MAX + 20 }, (_, index) => checkpoint(index, 1))
    expect(fitCheckpoints(list, Number.POSITIVE_INFINITY)).toHaveLength(CHECKPOINT_MAX)
  })

  test("a full store falls back to smaller payloads instead of throwing", () => {
    const storage = quotaStorage(3_000)
    const list = Array.from({ length: 10 }, (_, index) => checkpoint(10 - index, 1_000))
    expect(saveCheckpoints(storage, "key", list, 20_000)).toBe(true)
    const saved = JSON.parse(storage.values.get("key") ?? "[]") as { id: string }[]
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[0]?.id).toBe("c10")
  })

  test("when even one snapshot cannot fit, the history is kept without snapshots", () => {
    const storage = quotaStorage(500)
    const list = [checkpoint(2, 5_000), checkpoint(1, 5_000)]
    expect(saveCheckpoints(storage, "key", list)).toBe(true)
    expect(JSON.parse(storage.values.get("key") ?? "[]")).toEqual([{ id: "c2" }, { id: "c1" }])
  })

  test("reports failure only when nothing can be stored", () => {
    expect(saveCheckpoints(quotaStorage(1), "key", [checkpoint(1)])).toBe(false)
  })
})
