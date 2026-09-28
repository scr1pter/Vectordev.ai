import { describe, expect, test } from "bun:test"
import {
  cachedSpendPolicy,
  clearSpendPolicyCache,
  interactiveRunBudget,
  promptRunBudget,
  type SpendLimitsApi,
  type SpendPolicy,
} from "./spend-limits-api"

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

describe("cachedSpendPolicy", () => {
  const ledger = () => {
    const reads = { count: 0 }
    const policy: SpendPolicy = { interactive: { perRun: { usd: 2 } }, unattended: {} }
    const api: SpendLimitsApi = {
      limits: async () => {
        reads.count += 1
        return policy
      },
      setLimits: async () => policy,
      status: async () => {
        throw new Error("unused")
      },
      recent: async () => [],
    }
    return { api, reads, policy }
  }

  test("reads the ledger once per 30 seconds", async () => {
    clearSpendPolicyCache()
    const fake = ledger()
    expect(await cachedSpendPolicy(fake.api, 1_000)).toBe(fake.policy)
    expect(await cachedSpendPolicy(fake.api, 30_999)).toBe(fake.policy)
    expect(fake.reads.count).toBe(1)
    await cachedSpendPolicy(fake.api, 31_000)
    expect(fake.reads.count).toBe(2)
  })

  test("clearing the cache forces a fresh read", async () => {
    clearSpendPolicyCache()
    const fake = ledger()
    await cachedSpendPolicy(fake.api, 1_000)
    clearSpendPolicyCache()
    await cachedSpendPolicy(fake.api, 1_001)
    expect(fake.reads.count).toBe(2)
  })
})

describe("promptRunBudget", () => {
  const policy = (usd: number, warnAt?: number): SpendPolicy => ({
    interactive: { perRun: warnAt === undefined ? { usd } : { usd, warnAt } },
    unattended: {},
  })

  test("the interactive cap is added to the configured budget, not swapped for it", () => {
    expect(promptRunBudget({ configured: { usd: 2, steps: 60 }, policy: policy(10) })).toEqual({ usd: 2, steps: 60 })
    expect(promptRunBudget({ configured: { usd: 20, steps: 60, unpricedSteps: 40 }, policy: policy(10, 0.7) })).toEqual(
      { usd: 10, steps: 60, unpricedSteps: 40, warnAt: 0.7 },
    )
    expect(promptRunBudget({ configured: { steps: 60 }, policy: policy(10) })).toEqual({ usd: 10, steps: 60 })
  })

  test("with no interactive cap nothing is sent and the engine applies the config itself", () => {
    expect(promptRunBudget({ configured: { usd: 2, steps: 60 }, policy: undefined })).toBeUndefined()
    expect(promptRunBudget({ configured: undefined, policy: { interactive: {}, unattended: {} } })).toBeUndefined()
  })

  test("a continuation renews the stopped cap and keeps the step limit and warn threshold", () => {
    expect(promptRunBudget({ configured: { usd: 2, steps: 60 }, policy: policy(10, 0.7), capUsd: 5 })).toEqual({
      usd: 5,
      steps: 60,
      warnAt: 0.7,
    })
    expect(promptRunBudget({ configured: undefined, policy: undefined, capUsd: 5 })).toEqual({ usd: 5 })
  })
})
