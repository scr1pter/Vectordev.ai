import { describe, expect, test } from "bun:test"
import {
  activeAttributions,
  agentColor,
  ATTRIBUTION_TTL_MS,
  changedLineRanges,
  mergeAttribution,
  type AgentAttribution,
} from "./editor-attribution"

describe("changedLineRanges", () => {
  test("is empty when nothing changed", () => {
    expect(changedLineRanges("a\nb\nc", "a\nb\nc")).toEqual([])
  })

  test("finds a single changed line, 1-based", () => {
    expect(changedLineRanges("a\nb\nc", "a\nB\nc")).toEqual([{ start: 2, end: 2 }])
  })

  test("finds a contiguous changed block", () => {
    expect(changedLineRanges("a\nb\nc\nd", "a\nX\nY\nd")).toEqual([{ start: 2, end: 3 }])
  })

  test("covers inserted lines", () => {
    expect(changedLineRanges("a\nd", "a\nb\nc\nd")).toEqual([{ start: 2, end: 3 }])
  })

  test("marks the seam on a pure deletion rather than an inverted range", () => {
    const ranges = changedLineRanges("a\nb\nc", "a\nc")
    expect(ranges).toHaveLength(1)
    expect(ranges[0]!.start).toBeLessThanOrEqual(ranges[0]!.end)
    expect(ranges[0]!.start).toBeGreaterThan(0)
  })

  test("handles a change at the first and last line", () => {
    expect(changedLineRanges("a\nb", "X\nb")).toEqual([{ start: 1, end: 1 }])
    expect(changedLineRanges("a\nb", "a\nY")).toEqual([{ start: 2, end: 2 }])
  })

  test("handles emptying a file without producing a range Monaco would reject", () => {
    for (const range of changedLineRanges("a\nb", "")) {
      expect(range.start).toBeGreaterThan(0)
      expect(range.end).toBeGreaterThanOrEqual(range.start)
    }
  })

  test("handles writing into an empty file", () => {
    expect(changedLineRanges("", "hello")).toEqual([{ start: 1, end: 1 }])
  })

  test("never returns a range starting below line 1", () => {
    const samples: [string, string][] = [
      ["", "a"],
      ["a", ""],
      ["a\nb\nc", "c"],
      ["x", "x\ny"],
    ]
    for (const [before, after] of samples) {
      for (const range of changedLineRanges(before, after)) expect(range.start).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("agentColor", () => {
  test("is stable for the same agent", () => {
    expect(agentColor("agent-1")).toBe(agentColor("agent-1"))
  })

  test("returns a real hex colour", () => {
    expect(agentColor("anything")).toMatch(/^#[0-9a-f]{6}$/i)
  })

  test("spreads distinct agents across the palette", () => {
    const colors = new Set(Array.from({ length: 10 }, (_, i) => agentColor(`agent-${i}`)))
    expect(colors.size).toBeGreaterThan(1)
  })
})

describe("attribution lifetime", () => {
  const entry = (agentId: string, at: number): AgentAttribution => ({
    agentId,
    agentName: agentId,
    color: "#fff",
    ranges: [{ start: 1, end: 1 }],
    at,
  })

  test("drops attributions past the ttl", () => {
    const now = 1_000_000
    const kept = activeAttributions([entry("a", now - 1_000), entry("b", now - ATTRIBUTION_TTL_MS - 1)], now)
    expect(kept.map((item) => item.agentId)).toEqual(["a"])
  })

  test("replaces an agent's previous attribution rather than stacking", () => {
    const now = 1_000_000
    const merged = mergeAttribution([entry("a", now - 100)], entry("a", now), now)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.at).toBe(now)
  })

  test("keeps other agents while replacing one", () => {
    const now = 1_000_000
    const merged = mergeAttribution([entry("a", now - 100), entry("b", now - 100)], entry("a", now), now)
    expect(merged.map((item) => item.agentId).sort()).toEqual(["a", "b"])
  })
})
