import { describe, expect, test } from "bun:test"

import {
  appendTurn,
  continuationPrompt,
  extendStreamTail,
  settleRunningTurns,
  settleTurn,
  type ParallelWorkspaceTurn,
} from "./parallel-workspace-turns"

function turn(overrides: Partial<ParallelWorkspaceTurn> & { id: string }): ParallelWorkspaceTurn {
  return { role: "agent", text: "", at: "2026-08-24T00:00:00.000Z", state: "done", ...overrides }
}

describe("workspace turn transcript", () => {
  test("appendTurn keeps the newest 120 in arrival order", () => {
    const many = Array.from({ length: 130 }, (_value, index) => turn({ id: `t${index}` }))
    const capped = many.reduce<ParallelWorkspaceTurn[]>((turns, next) => appendTurn(turns, next), [])
    expect(capped.length).toBe(120)
    expect(capped[0]?.id).toBe("t10")
    expect(capped.at(-1)?.id).toBe("t129")
  })

  test("settleTurn patches only the matching turn and clears its live output", () => {
    const turns = [turn({ id: "a", state: "running", streamTail: ["x"] }), turn({ id: "b", state: "running" })]
    const settled = settleTurn(turns, "a", { text: "done at last", state: "done", cost: "$0.01" })
    expect(settled[0]).toMatchObject({ id: "a", text: "done at last", state: "done", cost: "$0.01" })
    expect(settled[0]?.streamTail).toBeUndefined()
    expect(settled[1]?.state).toBe("running")
  })

  test("settleTurn keeps existing text when the patch omits it, and ignores unknown ids", () => {
    const turns = [turn({ id: "a", text: "partial", state: "running" })]
    expect(settleTurn(turns, "a", { state: "stopped" })[0]?.text).toBe("partial")
    expect(settleTurn(turns, "missing", { state: "done" })).toEqual(turns)
  })

  test("extendStreamTail appends in arrival order and caps at 40", () => {
    // Guards the defensive copy in runExternalWorkspacePass: the caller holds a
    // live array it then reverses in place for the log view.
    const seeded = extendStreamTail([turn({ id: "a", state: "running" })], "a", ["one", "two"])
    expect(seeded[0]?.streamTail).toEqual(["one", "two"])
    const filled = extendStreamTail(
      seeded,
      "a",
      Array.from({ length: 60 }, (_value, index) => `line${index}`),
    )
    expect(filled[0]?.streamTail?.length).toBe(40)
    expect(filled[0]?.streamTail?.at(-1)).toBe("line59")
  })

  test("settleRunningTurns closes only running turns and preserves what they already said", () => {
    const turns = [
      turn({ id: "a", state: "done", text: "finished" }),
      turn({ id: "b", state: "running", text: "half said", streamTail: ["x"] }),
      turn({ id: "c", state: "running" }),
    ]
    const swept = settleRunningTurns(turns, { state: "failed", text: "Vector closed." })
    expect(swept[0]).toEqual(turns[0])
    expect(swept[1]).toMatchObject({ state: "failed", text: "half said" })
    expect(swept[1]?.streamTail).toBeUndefined()
    expect(swept[2]).toMatchObject({ state: "failed", text: "Vector closed." })
  })
})

describe("continuation prompt", () => {
  test("carries the instruction, the prior summary and every changed file", () => {
    const prompt = continuationPrompt({
      missionBrief: "Original mission.",
      previousSummary: "Renamed the helper.",
      changedFiles: ["src/a.ts", "src/b.ts"],
      instruction: "Now add a test.",
    })
    expect(prompt).toContain("Original mission.")
    expect(prompt).toContain("Renamed the helper.")
    expect(prompt).toContain("- src/a.ts")
    expect(prompt).toContain("- src/b.ts")
    expect(prompt).toContain("New instruction: Now add a test.")
  })

  test("says so explicitly when nothing has changed yet rather than emitting an empty list", () => {
    const prompt = continuationPrompt({
      missionBrief: "Original mission.",
      previousSummary: "",
      changedFiles: [],
      instruction: "Start over.",
    })
    expect(prompt).toContain("No files have been changed in this workspace yet.")
    expect(prompt).not.toContain("do not redo this work")
  })
})
