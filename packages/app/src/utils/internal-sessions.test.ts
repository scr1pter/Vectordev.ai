import { describe, expect, test } from "bun:test"
import { helperLabel, isInternalSession } from "./internal-sessions"

describe("isInternalSession", () => {
  test("recognises sessions the engine marked as helpers", () => {
    expect(isInternalSession({ internal: "vectorscope.verify", title: "Vectorscope review · #3 · verify" })).toBe(true)
    expect(isInternalSession({ internal: "codespace.autocomplete", title: "Autocomplete" })).toBe(true)
  })

  test("recognises helpers from an engine that predates the marker by their titles", () => {
    expect(isInternalSession({ title: "Vector Tool · Browser Agent Planner" })).toBe(true)
    expect(isInternalSession({ title: "Vectorscope review · uncommitted changes · review" })).toBe(true)
    expect(isInternalSession({ title: "Vector review · #12 · review" })).toBe(true)
    expect(isInternalSession({ title: "Vector review · 1a2b3c4 · verify" })).toBe(true)
    expect(isInternalSession({ title: "Vecbot review · #7 · security" })).toBe(true)
    expect(isInternalSession({ title: "Vecbot review · 0f9e8d7 · review" })).toBe(true)
  })

  test("leaves the user's own sessions alone", () => {
    expect(isInternalSession({ title: "Review the Vectorscope panel" })).toBe(false)
    expect(isInternalSession({ title: "Vector review · notes for the launch" })).toBe(false)
    expect(isInternalSession({ title: "Vector review · login · review" })).toBe(false)
    expect(isInternalSession({ title: "Vector review · #12 login · security" })).toBe(false)
    expect(isInternalSession({ title: "New session - 2026-10-10T10:00:00.000Z" })).toBe(false)
    expect(isInternalSession(undefined)).toBe(false)
  })
})

describe("helperLabel", () => {
  test("names every Vectorscope pass as the review the user started", () => {
    expect(helperLabel("vectorscope.review")).toBe("Vectorscope review")
    expect(helperLabel("vectorscope.security")).toBe("Vectorscope review")
    expect(helperLabel("vectorscope.verify")).toBe("Vectorscope review")
  })

  test("names the editor helpers and planners, and anything newer generically", () => {
    expect(helperLabel("codespace.edit")).toBe("Inline edit")
    expect(helperLabel("codespace.autocomplete")).toBe("Autocomplete")
    expect(helperLabel("swarm.planner")).toBe("Swarm planner")
    expect(helperLabel("browser-agent.planner")).toBe("Browser Agent planner")
    expect(helperLabel("brain.distill")).toBe("Document suggestions")
    expect(helperLabel("something.new")).toBe("Vector helper")
  })
})
