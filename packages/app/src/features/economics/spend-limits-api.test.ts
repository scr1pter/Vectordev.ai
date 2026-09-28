import { describe, expect, test } from "bun:test"
import { cachedSpendPolicy, interactiveRunBudget } from "./spend-limits-api"

describe("interactiveRunBudget", () => {
  test("a foreground chat carries the interactive per-run cap and its warn threshold", () => {
    expect(interactiveRunBudget({ interactive: { perRun: { usd: 2, warnAt: 0.7 } }, unattended: {} })).toEqual({
      usd: 2,
      warnAt: 0.7,
    })
    expect(interactiveRunBudget({ interactive: { perRun: { usd: 2 } }, unattended: {} })).toEqual({ usd: 2 })
  })

  test("no cap, a zero cap or no ledger sends no budget", () => {
    expect(interactiveRunBudget({ interactive: {}, unattended: { perRun: { usd: 5 } } })).toBeUndefined()
    expect(interactiveRunBudget({ interactive: { perRun: { usd: 0 } }, unattended: {} })).toBeUndefined()
    expect(interactiveRunBudget(undefined)).toBeUndefined()
  })

  test("without the desktop ledger there is no policy to read", async () => {
    expect(await cachedSpendPolicy()).toBeUndefined()
  })
})
