import { describe, expect, test } from "bun:test"
import { SUBAGENT_IDENTITIES, subagentIdentity } from "./subagent-identity"

// The engine's built-in subagents (packages/opencode/src/agent/agent.ts).
// A new engine subagent without an identity would render nameless, so this
// list is pinned deliberately rather than derived.
const ENGINE_SUBAGENTS = ["explore", "general", "judge", "debug", "migration", "performance", "review", "security", "test"]

describe("subagent identities", () => {
  test("covers every built-in engine subagent", () => {
    expect(Object.keys(SUBAGENT_IDENTITIES).sort()).toEqual([...ENGINE_SUBAGENTS].sort())
  })

  test("every identity is complete and its hue is a real angle", () => {
    for (const identity of Object.values(SUBAGENT_IDENTITIES)) {
      expect(identity.name.length).toBeGreaterThan(0)
      expect(identity.summary.length).toBeGreaterThan(0)
      expect(identity.detail.length).toBeGreaterThan(0)
      expect(identity.hue).toBeGreaterThanOrEqual(0)
      expect(identity.hue).toBeLessThan(360)
    }
  })

  test("names are unique so two agents can never be confused", () => {
    const names = Object.values(SUBAGENT_IDENTITIES).map((identity) => identity.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // review, security and judge cannot edit files; saying so in the UI is only
  // honest if the flag matches the engine's own permissions.
  test("the read-only agents are marked read-only", () => {
    expect(SUBAGENT_IDENTITIES.review!.readOnly).toBe(true)
    expect(SUBAGENT_IDENTITIES.security!.readOnly).toBe(true)
    expect(SUBAGENT_IDENTITIES.judge!.readOnly).toBe(true)
    expect(SUBAGENT_IDENTITIES.explore!.readOnly).toBeUndefined()
  })

  test("each identity's key matches its own id", () => {
    for (const [key, identity] of Object.entries(SUBAGENT_IDENTITIES)) expect(identity.id).toBe(key)
  })

  // A user-defined agent has no identity and must keep rendering as it did.
  test("an unknown or missing agent id has no identity", () => {
    expect(subagentIdentity("my-custom-agent")).toBeUndefined()
    expect(subagentIdentity(undefined)).toBeUndefined()
    expect(subagentIdentity("")).toBeUndefined()
  })

  test("a known id resolves", () => {
    expect(subagentIdentity("explore")?.name).toBe("Explore")
    expect(subagentIdentity("judge")?.name).toBe("Judge")
  })
})
