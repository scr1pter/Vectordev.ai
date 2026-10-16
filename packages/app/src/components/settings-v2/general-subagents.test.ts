import { describe, expect, test } from "bun:test"
import type { Config } from "@vectordevai/sdk/v2/client"
import { generalSubagentsEnabled, generalSubagentsPatch, runningWork, stopWorkDescription } from "./general-subagents"

describe("runningWork", () => {
  const helpers: Record<string, string> = {
    review: "Vectorscope review",
    security: "Vectorscope review",
    type: "Autocomplete",
  }
  const helperOf = (sessionID: string) => helpers[sessionID]

  test("counts every session that is not idle", () => {
    expect(runningWork({}, helperOf)).toEqual({ sessions: 0, helpers: [] })
    expect(runningWork({ a: { type: "idle" } }, helperOf)).toEqual({ sessions: 0, helpers: [] })
    expect(
      runningWork({ a: { type: "idle" }, b: { type: "busy" }, c: { type: "retry" }, d: undefined }, helperOf),
    ).toEqual({ sessions: 2, helpers: [] })
  })

  test("names Vector's running helpers instead of counting them as sessions", () => {
    expect(
      runningWork(
        { b: { type: "busy" }, review: { type: "busy" }, security: { type: "busy" }, type: { type: "idle" } },
        helperOf,
      ),
    ).toEqual({ sessions: 1, helpers: ["Vectorscope review"] })
  })
})

describe("stopWorkDescription", () => {
  test("says how many sessions the change stops", () => {
    expect(stopWorkDescription({ sessions: 1, helpers: [] })).toContain("1 session is working right now")
    expect(stopWorkDescription({ sessions: 1, helpers: [] })).toContain("stops it")
    expect(stopWorkDescription({ sessions: 4, helpers: [] })).toContain(
      "4 sessions are working right now, subagents included",
    )
    expect(stopWorkDescription({ sessions: 4, helpers: [] })).toContain("stops all of them")
  })

  test("says which of Vector's helpers stop, never calling them sessions", () => {
    const helpersOnly = stopWorkDescription({ sessions: 0, helpers: ["Vectorscope review"] })
    expect(helpersOnly).toBe(
      "One of Vector's helpers is working right now (Vectorscope review). Changing this setting stops it, and the new setting applies from your next message.",
    )
    expect(helpersOnly).not.toContain("session")
    expect(stopWorkDescription({ sessions: 0, helpers: ["Vectorscope review", "Autocomplete"] })).toBe(
      "Vector's helpers are working right now (Vectorscope review, Autocomplete). Changing this setting stops all of them, and the new setting applies from your next message.",
    )
    expect(stopWorkDescription({ sessions: 1, helpers: ["Vectorscope review", "Autocomplete"] })).toBe(
      "1 session is working right now. Vector's helpers are working too (Vectorscope review, Autocomplete). Changing this setting stops all of them, and the new setting applies from your next message.",
    )
  })
})

describe("generalSubagentsEnabled", () => {
  test("is on when the config says nothing about it", () => {
    expect(generalSubagentsEnabled({})).toBe(true)
    expect(generalSubagentsEnabled({ agent: {} })).toBe(true)
    expect(generalSubagentsEnabled({ agent: { general: {} } })).toBe(true)
  })

  test("is on when general is explicitly not disabled", () => {
    expect(generalSubagentsEnabled({ agent: { general: { disable: false } } })).toBe(true)
  })

  test("is off only when general is disabled", () => {
    expect(generalSubagentsEnabled({ agent: { general: { disable: true } } })).toBe(false)
  })

  test("ignores other agents being disabled", () => {
    const config: Config = { agent: { explore: { disable: true }, reviewer: { disable: true } } }
    expect(generalSubagentsEnabled(config)).toBe(true)
  })
})

describe("generalSubagentsPatch", () => {
  test("touches only agent.general.disable", () => {
    expect(generalSubagentsPatch(false)).toEqual({ agent: { general: { disable: true } } })
    expect(generalSubagentsPatch(true)).toEqual({ agent: { general: { disable: false } } })
  })

  test("round-trips through the reader", () => {
    expect(generalSubagentsEnabled(generalSubagentsPatch(false))).toBe(false)
    expect(generalSubagentsEnabled(generalSubagentsPatch(true))).toBe(true)
  })
})
