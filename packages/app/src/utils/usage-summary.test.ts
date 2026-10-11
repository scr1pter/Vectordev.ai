import { describe, expect, test } from "bun:test"
import { helperUsage, normalizeUsageSummary } from "./usage-summary"

describe("helperUsage", () => {
  test("groups helper spend under the names the user knows, most expensive first", () => {
    expect(
      helperUsage([
        { id: "codespace.autocomplete", sessions: 9, responses: 54, tokens: 40_000, cost: 0.03 },
        { id: "vectorscope.review", sessions: 2, responses: 14, tokens: 90_000, cost: 0.4 },
        { id: "vectorscope.verify", sessions: 2, responses: 2, tokens: 10_000, cost: 0.05 },
      ]),
    ).toEqual([
      { label: "Vectorscope review", sessions: 4, responses: 16, tokens: 100_000, cost: 0.45 },
      { label: "Autocomplete", sessions: 9, responses: 54, tokens: 40_000, cost: 0.03 },
    ])
  })

  test("is empty for a server that reports no helpers", () => {
    expect(helperUsage(normalizeUsageSummary({}).helpers)).toEqual([])
  })
})
