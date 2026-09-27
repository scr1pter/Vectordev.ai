import { describe, expect, test } from "bun:test"
import { SpendGuard } from "@vectordevai/core/spend-guard"

describe("SpendGuard cost kind and price", () => {
  test("costKindOf puts free before plan before priced", () => {
    expect(SpendGuard.costKindOf({ free: true, oauthPlan: true, listed: true })).toBe("free")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: true, listed: true })).toBe("plan")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: true })).toBe("priced")
    expect(SpendGuard.costKindOf({ free: false, oauthPlan: false, listed: false })).toBe("unknown")
  })

  test("priceOf has no price for all-zero rates", () => {
    expect(SpendGuard.priceOf({ input: 0, output: 0, cache: { read: 0.5, write: 1 } })).toBeUndefined()
    expect(SpendGuard.priceOf({ input: 0, output: 0 })).toBeUndefined()
  })

  test("priceOf keeps cache rates only when they are listed", () => {
    expect(SpendGuard.priceOf({ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } })).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
    })
    expect(SpendGuard.priceOf({ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } })).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    })
  })
})
