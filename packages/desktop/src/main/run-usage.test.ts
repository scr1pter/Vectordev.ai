import { describe, expect, test } from "bun:test"
import { SessionID } from "@vectordevai/schema/session-id"
import { combineSpend, formatUsd, measuredCost, readSpend, tokenTotal, usageDelta } from "./run-usage"

const snapshot = (input: { spentUsd: number; unpricedSteps?: number; costKind?: "priced" | "unknown" | "free" }) => ({
  sessionID: SessionID.make("ses_run_usage"),
  state: "ok" as const,
  budget: { usd: 5 },
  spentUsd: input.spentUsd,
  steps: 3,
  unpricedSteps: input.unpricedSteps ?? 0,
  costKind: input.costKind ?? "priced",
})

describe("usageDelta", () => {
  test("is undefined when either reading is missing", () => {
    expect(usageDelta(undefined, 1)).toBeUndefined()
    expect(usageDelta(1, undefined)).toBeUndefined()
  })

  test("never runs backwards", () => {
    expect(usageDelta(2, 0.5)).toBe(0)
    expect(usageDelta(0.5, 2)).toBe(1.5)
  })
})

describe("tokenTotal", () => {
  test("sums every reported bucket and is undefined when none is reported", () => {
    expect(tokenTotal({ input: 10, output: 5, cache: { read: 2 } })).toBe(17)
    expect(tokenTotal({})).toBeUndefined()
    expect(tokenTotal(undefined)).toBeUndefined()
  })
})

describe("measuredCost", () => {
  test("prefers the guard's reading for a priced run", () => {
    // A revert lowered the session total, but the money was still spent.
    expect(measuredCost(snapshot({ spentUsd: 0.42 }), 0, 0.1)).toBe(0.42)
  })

  test("does not undercount a run whose earlier drains left the snapshot", () => {
    expect(measuredCost(snapshot({ spentUsd: 0.1 }), 0, 0.42)).toBe(0.42)
  })

  test("is unknown when unpriced steps ran and nothing was measured", () => {
    expect(measuredCost(snapshot({ spentUsd: 0, unpricedSteps: 2, costKind: "unknown" }), 1, 1)).toBeUndefined()
    expect(measuredCost(snapshot({ spentUsd: 0, unpricedSteps: 2, costKind: "unknown" }), undefined, undefined)).toBe(
      undefined,
    )
  })

  test("falls back to the session delta without a guard reading", () => {
    expect(measuredCost(undefined, 1, 1.25)).toBe(0.25)
    expect(measuredCost(undefined, undefined, 1)).toBeUndefined()
  })
})

describe("readSpend", () => {
  test("reads the snapshot from the spend route", async () => {
    const paths: string[] = []
    const read = await readSpend(async (path) => {
      paths.push(path)
      return { data: snapshot({ spentUsd: 1.5 }) }
    }, "ses_run_usage")
    expect(paths).toEqual(["/api/session/ses_run_usage/spend"])
    expect(read?.spentUsd).toBe(1.5)
  })

  test("is undefined for an empty, malformed or failed answer", async () => {
    expect(await readSpend(async () => ({}), "ses_a")).toBeUndefined()
    expect(await readSpend(async () => ({ data: { spentUsd: "lots" } }), "ses_a")).toBeUndefined()
    expect(
      await readSpend(async () => {
        throw new Error("engine down")
      }, "ses_a"),
    ).toBeUndefined()
  })
})

describe("combineSpend", () => {
  test("adds each drain's spend and steps to the run", () => {
    const first = combineSpend(undefined, snapshot({ spentUsd: 0.3 }))
    const both = combineSpend(first, snapshot({ spentUsd: 0.12, unpricedSteps: 1 }))
    expect(both?.spentUsd).toBeCloseTo(0.42)
    expect(both?.steps).toBe(6)
    expect(both?.unpricedSteps).toBe(1)
    expect(combineSpend(first, undefined)).toBe(first)
  })
})

describe("formatUsd", () => {
  test("shows cents, and a tiny real spend as under a cent", () => {
    expect(formatUsd(0.42)).toBe("$0.42")
    expect(formatUsd(0.004)).toBe("<$0.01")
    expect(formatUsd(0)).toBe("$0.00")
  })
})
