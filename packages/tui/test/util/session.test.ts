import { describe, expect, test } from "bun:test"
import { delegatedSpendLines, isDefaultTitle } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })
})

describe("delegatedSpendLines", () => {
  const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  const session = { title: "fix the login form", cost: 1, subagentCost: 0.5, subagentTokens: tokens(3_000) }

  test("says nothing for a session that delegated nothing", () => {
    expect(delegatedSpendLines({ title: "solo", cost: 1 }, [])).toEqual([])
    expect(delegatedSpendLines(undefined, undefined)).toEqual([])
  })

  test("does not say who spent it until the children are read", () => {
    expect(delegatedSpendLines(session, undefined)).toEqual(["$0.50 · 3.0K tokens by subagents or Vector's helpers"])
  })

  test("a session whose only delegated spend is a subagent never mentions helpers", () => {
    const child = { title: "explore", cost: 0.5, tokens: tokens(3_000) }
    expect(delegatedSpendLines(session, [child])).toEqual(["$0.50 · 3.0K tokens by subagents"])
  })

  test("splits what the helpers spent from what the subagents spent, tokens included", () => {
    const children = [
      { title: "explore", cost: 0.3, tokens: tokens(1_000) },
      {
        title: "Vectorscope review · 1a2b3c4 · review",
        internal: "vectorscope.review",
        cost: 0.2,
        tokens: tokens(2_000),
      },
    ]
    expect(delegatedSpendLines(session, children)).toEqual([
      "$0.30 · 1.0K tokens by subagents",
      "$0.20 · 2.0K tokens by Vector's helpers",
    ])
    expect(delegatedSpendLines(session, [{ ...children[1], cost: 0.5, tokens: tokens(3_000) }])).toEqual([
      "$0.50 · 3.0K tokens by Vector's helpers",
    ])
  })
})
