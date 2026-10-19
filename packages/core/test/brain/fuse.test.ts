import { describe, expect, test } from "bun:test"
import { BrainFuse } from "@vectordevai/core/brain/fuse"

describe("BrainFuse", () => {
  test("rrf adds each list's weight over 60 plus the rank", () => {
    const fused = BrainFuse.rrf([
      { weight: 1, ids: ["a", "b"] },
      { weight: 1, ids: ["b", "c"] },
    ])
    expect(fused.get("a")).toBeCloseTo(1 / 61)
    expect(fused.get("b")).toBeCloseTo(1 / 62 + 1 / 61)
    expect(fused.get("c")).toBeCloseTo(1 / 62)
    // Found by two channels beats first in one.
    expect(fused.get("b")!).toBeGreaterThan(fused.get("a")!)
  })

  test("rrf reads only the top 50 of a list and weighs each list", () => {
    const ids = Array.from({ length: 60 }, (_, index) => `i${index}`)
    const fused = BrainFuse.rrf([{ weight: 2, ids }])
    expect(fused.size).toBe(50)
    expect(fused.get("i0")).toBeCloseTo(2 / 61)
    expect(fused.has("i55")).toBe(false)
  })

  test("the keyword gate takes two shared terms, or the only term of a short query", () => {
    expect(BrainFuse.eligible(2, 9)).toBe(true)
    expect(BrainFuse.eligible(1, 9)).toBe(false)
    expect(BrainFuse.eligible(1, 2)).toBe(true)
    expect(BrainFuse.eligible(0, 1)).toBe(false)
  })

  test("value is the fused share of the best, times trust, freshness, proof and confidence", () => {
    expect(
      BrainFuse.value({ fused: 0.5, best: 1, trust: 0.85, freshness: 1, proven: 1, confidence: 0.9 }),
    ).toBeCloseTo(0.5 * 0.85 * 0.9)
    expect(BrainFuse.value({ fused: 1, best: 0, trust: 1, freshness: 1, proven: 1, confidence: 1 })).toBe(0)
  })
})
