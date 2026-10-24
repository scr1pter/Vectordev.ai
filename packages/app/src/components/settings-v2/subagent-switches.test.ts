import { describe, expect, test } from "bun:test"
import type { Config } from "@vectordevai/sdk/v2/client"
import {
  SPECIALIST_IDS,
  agentEnabled,
  agentSwitchPatch,
  createAgentSwitchSaver,
  runningWork,
  stopWorkDescription,
} from "./subagent-switches"

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

describe("agentEnabled", () => {
  test("is on when the config says nothing about the agent", () => {
    expect(agentEnabled({}, "general")).toBe(true)
    expect(agentEnabled({ agent: {} }, "review")).toBe(true)
    expect(agentEnabled({ agent: { general: {} } }, "general")).toBe(true)
  })

  test("is on when the agent is explicitly not disabled", () => {
    expect(agentEnabled({ agent: { general: { disable: false } } }, "general")).toBe(true)
  })

  test("is off only when that agent is disabled", () => {
    const config: Config = { agent: { explore: { disable: true }, reviewer: { disable: true } } }
    expect(agentEnabled(config, "explore")).toBe(false)
    expect(agentEnabled(config, "general")).toBe(true)
    expect(agentEnabled(config, "review")).toBe(true)
  })
})

describe("SPECIALIST_IDS", () => {
  test("are the specialists that ship with Vector, and nothing else", () => {
    expect(SPECIALIST_IDS.toSorted()).toEqual([
      "debug",
      "explore",
      "judge",
      "migration",
      "performance",
      "review",
      "security",
      "test",
    ])
  })
})

describe("agentSwitchPatch", () => {
  test("touches only the picked agents' disable flags", () => {
    expect(agentSwitchPatch({ general: false })).toEqual({ agent: { general: { disable: true } } })
    expect(agentSwitchPatch({ general: true })).toEqual({ agent: { general: { disable: false } } })
    expect(agentSwitchPatch({ review: false, test: true })).toEqual({
      agent: { review: { disable: true }, test: { disable: false } },
    })
  })

  test("round-trips through the reader", () => {
    expect(agentEnabled(agentSwitchPatch({ general: false }), "general")).toBe(false)
    expect(agentEnabled(agentSwitchPatch({ general: true }), "general")).toBe(true)
  })
})

// An engine stand-in for the saver: each save is one config update, and so one engine reload. It deep-merges the
// patch the way the global config update does, and a save can be held open or made to fail.
function engine() {
  const state = { config: {} as Config, saves: [] as Config[], hold: false, fail: false }
  const held: Array<() => void> = []
  const save = (patch: Config) => {
    state.saves.push(patch)
    const settle = () => {
      if (state.fail) throw new Error("config write failed")
      state.config = { ...state.config, agent: { ...state.config.agent, ...patch.agent } }
    }
    if (!state.hold) return Promise.resolve().then(settle)
    return new Promise<void>((resolve, reject) => held.push(() => Promise.resolve().then(settle).then(resolve, reject)))
  }
  return {
    state,
    save,
    saved: (id: string) => agentEnabled(state.config, id),
    release: () => held.splice(0).forEach((settle) => settle()),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("createAgentSwitchSaver", () => {
  test("rapid flips end in one save with the final state", async () => {
    const fake = engine()
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick({ general: false })
    saver.pick({ general: true })
    saver.pick({ general: false })
    expect(saver.enabled("general")).toBe(false)
    await settle()

    expect(fake.state.saves).toEqual([{ agent: { general: { disable: true } } }])
    expect(saver.enabled("general")).toBe(false)
  })

  test("flipping off and back on saves nothing", async () => {
    const fake = engine()
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick({ review: false })
    saver.pick({ review: true })
    await settle()

    expect(fake.state.saves).toEqual([])
    expect(saver.enabled("review")).toBe(true)
  })

  test("flips during a save go out in one more save, and the switch never flicks back", async () => {
    const fake = engine()
    fake.state.hold = true
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick({ general: false })
    await settle()
    expect(fake.state.saves).toHaveLength(1)

    saver.pick({ general: true })
    saver.pick({ general: false })
    saver.pick({ general: true })
    expect(saver.enabled("general")).toBe(true)
    await settle()
    // Nothing more goes out while the first save is in flight.
    expect(fake.state.saves).toHaveLength(1)

    fake.state.hold = false
    fake.release()
    await settle()
    expect(fake.state.saves).toEqual([
      { agent: { general: { disable: true } } },
      { agent: { general: { disable: false } } },
    ])
    expect(saver.enabled("general")).toBe(true)
    expect(fake.saved("general")).toBe(true)
  })

  test("a failed save puts the switch back and names it", async () => {
    const fake = engine()
    fake.state.fail = true
    const failures: string[][] = []
    const saver = createAgentSwitchSaver({
      saved: fake.saved,
      save: fake.save,
      onError: (_, ids) => failures.push(ids),
      delay: 5,
    })
    saver.pick({ security: false })
    expect(saver.enabled("security")).toBe(false)
    await settle()

    expect(failures).toEqual([["security"]])
    expect(saver.enabled("security")).toBe(true)
  })

  test("each specialist switch writes its own agent.<id>.disable", async () => {
    for (const id of SPECIALIST_IDS) {
      const fake = engine()
      const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 1 })
      saver.pick({ [id]: false })
      await saver.flush()

      expect(fake.state.saves).toEqual([{ agent: { [id]: { disable: true } } }])
      expect(SPECIALIST_IDS.filter((other) => !fake.saved(other))).toEqual([id])
      expect(fake.saved("general")).toBe(true)
    }
  })

  test("the all-specialists switch saves every specialist in one update and nothing else", async () => {
    const fake = engine()
    const saver = createAgentSwitchSaver({ saved: fake.saved, save: fake.save, onError: () => {}, delay: 5 })
    saver.pick(Object.fromEntries(SPECIALIST_IDS.map((id) => [id, false])))
    await settle()

    expect(fake.state.saves).toHaveLength(1)
    expect(Object.keys(fake.state.saves[0]?.agent ?? {}).toSorted()).toEqual(SPECIALIST_IDS.toSorted())
    for (const id of ["build", "plan", "general", "quick", "autocomplete", "compaction", "title", "summary"]) {
      expect(fake.state.saves[0]?.agent?.[id]).toBeUndefined()
    }
    expect(SPECIALIST_IDS.every((id) => !saver.enabled(id))).toBe(true)

    saver.pick(Object.fromEntries(SPECIALIST_IDS.map((id) => [id, true])))
    await settle()
    expect(fake.state.saves).toHaveLength(2)
    expect(SPECIALIST_IDS.every((id) => fake.saved(id))).toBe(true)
  })
})
