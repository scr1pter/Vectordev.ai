import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/sdk/v2/client"
import {
  generalSubagentsEnabled,
  generalSubagentsPatch,
  runningSessions,
  stopWorkDescription,
} from "./general-subagents"

describe("runningSessions", () => {
  test("counts every session that is not idle", () => {
    expect(runningSessions({})).toBe(0)
    expect(runningSessions({ a: { type: "idle" } })).toBe(0)
    expect(runningSessions({ a: { type: "idle" }, b: { type: "busy" }, c: { type: "retry" }, d: undefined })).toBe(2)
  })
})

describe("stopWorkDescription", () => {
  test("says how many sessions the change stops", () => {
    expect(stopWorkDescription(1)).toContain("1 session is working right now")
    expect(stopWorkDescription(1)).toContain("stops it")
    expect(stopWorkDescription(4)).toContain("4 sessions are working right now, subagents included")
    expect(stopWorkDescription(4)).toContain("stops all of them")
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
