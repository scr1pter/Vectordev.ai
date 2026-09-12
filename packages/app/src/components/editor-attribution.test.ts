import { describe, expect, test } from "bun:test"
import {
  activeAttributions,
  attributionsForPath,
  agentColor,
  agentCursorLine,
  ATTRIBUTION_TTL_MS,
  changedLineRanges,
  CURSOR_TAIL_MAX_LINES,
  DIFF_LINE_RANGES_MAX_CHARS,
  diffLineRanges,
  inferredLineRanges,
  locateInsertedText,
  locateInsertedTextNear,
  mergeAttribution,
  resolveAgentColor,
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
  const entry = (agentId: string, at: number, path = "src/a.ts"): AgentAttribution => ({
    path,
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

  test("one agent editing two files keeps a highlight in each", () => {
    const now = 1_000_000
    const merged = mergeAttribution([entry("a", now - 100, "src/a.ts")], entry("a", now, "src/b.ts"), now)
    expect(merged.map((item) => item.path).sort()).toEqual(["src/a.ts", "src/b.ts"])
  })

  test("attributionsForPath keeps only the ranges belonging to the open file", () => {
    const now = 1_000_000
    const all = [entry("a", now, "src/a.ts"), entry("b", now, "src/b.ts")]
    expect(attributionsForPath(all, "src/b.ts").map((item) => item.agentId)).toEqual(["b"])
    expect(attributionsForPath(all, "src/c.ts")).toEqual([])
  })
})

describe("resolveAgentColor", () => {
  const agents = [
    { name: "build", color: "#00ff00" },
    { name: "plan", color: "var(--icon-agent-plan-base)" },
    { name: "docs" },
  ]

  test("uses the agent's configured hex colour", () => {
    expect(resolveAgentColor("build", agents, "session-1")).toBe("#00ff00")
  })

  test("falls back to the stable palette when the colour is not plain hex", () => {
    expect(resolveAgentColor("plan", agents, "session-1")).toBe(agentColor("session-1"))
  })

  test("falls back when the agent has no colour or is unknown", () => {
    expect(resolveAgentColor("docs", agents, "session-1")).toBe(agentColor("session-1"))
    expect(resolveAgentColor("ghost", agents, "session-1")).toBe(agentColor("session-1"))
    expect(resolveAgentColor(undefined, agents, "session-1")).toBe(agentColor("session-1"))
  })
})

describe("locateInsertedText", () => {
  const after = "import a\n\nfunction one() {\n  return 1\n}\n\nfunction two() {\n  return 2\n}\n"

  test("finds an exact multi-line snippet, 1-based", () => {
    expect(locateInsertedText(after, "function two() {\n  return 2\n}")).toEqual({ start: 7, end: 9 })
  })

  test("ignores a trailing newline on the snippet", () => {
    expect(locateInsertedText(after, "function one() {\n  return 1\n}\n")).toEqual({ start: 3, end: 5 })
  })

  test("falls back to the first non-blank line when a formatter reflowed the rest", () => {
    expect(locateInsertedText(after, "function two() {\n    return   2\n}")).toEqual({ start: 7, end: 9 })
  })

  test("clamps the loose match to the end of the file", () => {
    expect(locateInsertedText("a\nb", "b\nc\nd\ne")).toEqual({ start: 2, end: 2 })
  })

  test("returns nothing for blank or missing text", () => {
    expect(locateInsertedText(after, "   \n\n")).toBeUndefined()
    expect(locateInsertedText(after, "function three()")).toBeUndefined()
  })
})

describe("inferredLineRanges", () => {
  test("attributes the whole file to a write", () => {
    expect(inferredLineRanges("a\nb\nc", { tool: "write", input: { content: "a\nb\nc" } })).toEqual([
      { start: 1, end: 3 },
    ])
  })

  test("locates an edit's newString", () => {
    expect(inferredLineRanges("a\nb\nc", { tool: "edit", input: { newString: "b" } })).toEqual([{ start: 2, end: 2 }])
  })

  test("is empty for unknown tools, missing input, or no call", () => {
    expect(inferredLineRanges("a", { tool: "apply_patch", input: { patch: "x" } })).toEqual([])
    expect(inferredLineRanges("a", { tool: "edit", input: {} })).toEqual([])
    expect(inferredLineRanges("a", undefined)).toEqual([])
  })
})

describe("agentCursorLine", () => {
  test("sits at the end of a short block", () => {
    expect(agentCursorLine({ start: 4, end: 9 })).toBe(9)
  })

  test("sits at the start of a block too tall for the viewport", () => {
    expect(agentCursorLine({ start: 1, end: 1 + CURSOR_TAIL_MAX_LINES + 1 })).toBe(1)
  })
})

describe("diffLineRanges", () => {
  test("is empty when nothing changed", () => {
    expect(diffLineRanges("a\nb", "a\nb")).toEqual([])
  })

  test("gives one range per separate hunk instead of tinting everything between", () => {
    expect(diffLineRanges("a\nb\nc\nd\ne\nf\ng", "a\nB\nc\nd\ne\nF\ng")).toEqual([
      { start: 2, end: 2 },
      { start: 6, end: 6 },
    ])
  })

  test("covers an inserted block", () => {
    expect(diffLineRanges("a\nd", "a\nb\nc\nd")).toEqual([{ start: 2, end: 3 }])
  })

  test("marks the seam on a pure deletion", () => {
    expect(diffLineRanges("a\nb\nc", "a\nc")).toEqual([{ start: 2, end: 2 }])
  })

  test("does not count a new final newline as a change to the old last line", () => {
    expect(diffLineRanges("a\nb", "a\nb\nc")).toEqual([{ start: 3, end: 3 }])
  })

  test("never returns a range Monaco would reject", () => {
    const samples: [string, string][] = [
      ["", "a"],
      ["a", ""],
      ["a\nb\nc", "c"],
      ["x", "x\ny"],
      ["a\nb", ""],
      ["a\nb\nc\nd", "d\nc\nb\na"],
    ]
    for (const [before, after] of samples) {
      const total = after.split("\n").length
      for (const range of diffLineRanges(before, after)) {
        expect(range.start).toBeGreaterThanOrEqual(1)
        expect(range.end).toBeGreaterThanOrEqual(range.start)
        expect(range.end).toBeLessThanOrEqual(total)
      }
    }
  })

  test("falls back to one prefix/suffix range above the size cap", () => {
    const filler = "x\n".repeat(Math.ceil(DIFF_LINE_RANGES_MAX_CHARS / 4) + 1)
    const before = `a\n${filler}b\n`
    const after = `A\n${filler}B\n`
    expect(diffLineRanges(before, after)).toEqual(changedLineRanges(before, after))
  })
})

describe("locateInsertedTextNear", () => {
  const after = "x\nfoo\ny\nfoo\nz"

  test("prefers the match closest to where the change was expected", () => {
    expect(locateInsertedTextNear(after, "foo", 4)).toEqual({ start: 4, end: 4 })
    expect(locateInsertedTextNear(after, "foo", 1)).toEqual({ start: 2, end: 2 })
  })

  test("behaves like locateInsertedText without a hint", () => {
    expect(locateInsertedTextNear(after, "foo")).toEqual(locateInsertedText(after, "foo"))
  })

  test("spans a multi-line snippet", () => {
    expect(locateInsertedTextNear("a\nb\nc\na\nb\nc", "a\nb", 5)).toEqual({ start: 4, end: 5 })
  })

  test("falls back to the loose match when the exact text is gone", () => {
    expect(locateInsertedTextNear("function two() {\n  return 2\n}", "function two() {\n    return   2\n}", 3)).toEqual(
      { start: 1, end: 3 },
    )
  })
})

describe("inferredLineRanges for apply_patch", () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@",
    " five",
    "+six",
    " seven",
    "*** End Patch",
  ].join("\n")
  const after = "zero\none\nTWO\nthree\nfour\nfive\nsix\nseven\n"

  test("attributes only the lines each chunk changed", () => {
    expect(inferredLineRanges(after, { tool: "apply_patch", input: { patchText } }, { path: "src/a.ts" })).toEqual([
      { start: 3, end: 3 },
      { start: 7, end: 7 },
    ])
  })

  test("uses the only hunk when no path is given", () => {
    expect(inferredLineRanges(after, { tool: "apply_patch", input: { patchText } })).toEqual([
      { start: 3, end: 3 },
      { start: 7, end: 7 },
    ])
  })

  test("matches an absolute patch path through normalize", () => {
    const absolute = patchText.replace("*** Update File: src/a.ts", "*** Update File: /repo/src/a.ts")
    const normalize = (file: string) => file.replace(/^\/repo\//, "")
    expect(
      inferredLineRanges(
        after,
        { tool: "apply_patch", input: { patchText: absolute } },
        { path: "src/a.ts", normalize },
      ),
    ).toEqual([
      { start: 3, end: 3 },
      { start: 7, end: 7 },
    ])
  })

  test("attributes the whole file to an added file", () => {
    const added = "*** Begin Patch\n*** Add File: src/new.ts\n+a\n+b\n*** End Patch"
    expect(
      inferredLineRanges("a\nb", { tool: "apply_patch", input: { patchText: added } }, { path: "src/new.ts" }),
    ).toEqual([{ start: 1, end: 2 }])
  })

  test("is empty for a file the patch does not touch or a malformed patch", () => {
    expect(inferredLineRanges(after, { tool: "apply_patch", input: { patchText } }, { path: "src/b.ts" })).toEqual([])
    expect(inferredLineRanges(after, { tool: "apply_patch", input: { patchText: "garbage" } })).toEqual([])
  })
})
