import { describe, expect, test } from "bun:test"
import {
  GENERAL_ALIASES,
  GENERAL_SUBAGENT,
  SUBAGENT_LABEL,
  SUBAGENT_TITLE_MAX,
  resolveSubagentType,
  subagentKind,
  subagentTitle,
} from "../../src/agent/subagent-kind"

const none = () => false

describe("agent.subagent-kind", () => {
  test("an omitted or blank subagent_type resolves to the general Subagent", () => {
    expect(resolveSubagentType(undefined, none)).toBe(GENERAL_SUBAGENT)
    expect(resolveSubagentType("", none)).toBe("general")
    expect(resolveSubagentType("   ", none)).toBe("general")
  })

  test("general-purpose aliases resolve to general unless an agent has that literal name", () => {
    for (const alias of GENERAL_ALIASES) expect(resolveSubagentType(alias, none)).toBe("general")
    expect(resolveSubagentType("General-Purpose", none)).toBe("general")
    expect(resolveSubagentType("General", none)).toBe("general")
    expect(resolveSubagentType("general-purpose", (name) => name === "general-purpose")).toBe("general-purpose")
  })

  test("named agents pass through trimmed, including unknown ones", () => {
    expect(resolveSubagentType(" explore ", (name) => name === "explore")).toBe("explore")
    expect(resolveSubagentType("nonexistent", none)).toBe("nonexistent")
  })

  test("general is the Subagent and every other subagent is a specialist", () => {
    expect(subagentKind({ name: "general", native: true })).toEqual({ kind: "subagent", custom: false })
    expect(subagentKind({ name: "explore", native: true })).toEqual({ kind: "specialist", custom: false })
    expect(subagentKind({ name: "reviewer", native: false })).toEqual({ kind: "specialist", custom: true })
    expect(subagentKind({ name: "reviewer" })).toEqual({ kind: "specialist", custom: true })
    expect(SUBAGENT_LABEL.subagent).toBe("Subagent")
    expect(SUBAGENT_LABEL.specialist).toBe("Subagent specialist")
  })

  test("titles are trimmed, collapsed, capped, and fall back to the prompt", () => {
    expect(subagentTitle("  Map   auth\nmiddleware ", "ignored")).toBe("Map auth middleware")
    expect(subagentTitle("", "Find every caller of the session cache and report them")).toBe(
      "Find every caller of the session",
    )
    expect(subagentTitle(" ", "   ")).toBe("Subagent task")
    const long = subagentTitle("word ".repeat(40), "")
    expect(long.length).toBeLessThanOrEqual(SUBAGENT_TITLE_MAX)
    expect(long.endsWith("…")).toBe(true)
    expect(long).not.toContain("  ")
  })
})
