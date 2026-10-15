import { describe, expect, test } from "bun:test"
import {
  modelPlanPurchasable,
  modelPlanRedirect,
  modelPlanRemaining,
  modelTopupPurchasable,
  modelWalletRemaining,
  readModelPlanConfig,
  readModelPlanStatus,
} from "./model-plans"

const plan = { id: "vector-10", name: "Vector 10", price: 10, available: true }
const config = { enabled: true, currency: "usd" as const, interval: "month" as const, plans: [plan] }
const status = {
  active: true as const,
  plan: plan.id,
  credits: 100,
  periodStart: 1_000,
  periodEnd: 2_000,
  cancelAtPeriodEnd: false,
}

describe("model plan API boundaries", () => {
  test("reads the public catalog while preserving disabled plans", () => {
    expect(readModelPlanConfig(config)).toEqual(config)
    expect(readModelPlanConfig({ ...config, enabled: false, plans: [{ ...plan, available: false }] })).toMatchObject({
      enabled: false,
      plans: [{ available: false }],
    })
  })

  test("keeps only public fields, even when a response carries credit amounts or model prices", () => {
    const read = readModelPlanConfig({
      ...config,
      plans: [{ ...plan, credits: 7, multiple: 5, tasks: [[60, 550], null] }],
      models: [{ id: "vendor/coder", name: "Coder", inputPrice: 0.1, outputPrice: 0.4, contextLength: 128_000 }],
    })
    expect(read.plans).toEqual([{ ...plan, multiple: 5, tasks: [[60, 550], null] }])
    expect(read.models).toEqual([{ id: "vendor/coder", name: "Coder" }])
  })

  test("rejects malformed prices, multiples, ranges, currencies and duplicate plan IDs", () => {
    for (const value of [
      null,
      { ...config, currency: "eur" },
      { ...config, plans: [plan, plan] },
      { ...config, plans: [{ ...plan, price: NaN }] },
      { ...config, plans: [{ ...plan, available: "true" }] },
      { ...config, plans: [{ ...plan, multiple: 1 }] },
      { ...config, plans: [{ ...plan, tasks: [[550, 60]] }] },
      { ...config, plans: [{ ...plan, tasks: [[0, 60]] }] },
      { ...config, plans: [{ ...plan, tasks: [[60]] }] },
      { ...config, plans: [{ ...plan, tasks: "60–550" }] },
    ]) {
      expect(() => readModelPlanConfig(value)).toThrow("could not load model plans")
    }
  })

  test("reads optional public coding models and one-time credit packs without changing older responses", () => {
    const model = {
      id: "vendor/coder",
      name: "Coder",
      category: "everyday" as const,
      description: "For routine coding tasks.",
    }
    const current = {
      ...config,
      product: "Vector Codium",
      models: [model],
      topups: [{ ...plan, id: "codium-topup-10" }],
    }
    expect(readModelPlanConfig(current)).toEqual(current)
    for (const invalid of [
      { ...current, models: [model, model] },
      { ...current, models: [{ ...model, name: " " }] },
      { ...current, models: [{ ...model, category: "best" }] },
      { ...current, models: [{ ...model, id: "not a model" }] },
      { ...current, topups: [plan] },
      { ...current, topups: "credit packs" },
    ]) {
      expect(() => readModelPlanConfig(invalid)).toThrow("could not load model plans")
    }
  })

  test("accepts inactive customers and keeps missing usage unknown", () => {
    expect(readModelPlanStatus({ active: false, customer: true })).toEqual({ active: false, customer: true })
    expect(readModelPlanStatus(status)).toEqual(status)
    expect(modelPlanRemaining(status)).toBeUndefined()
  })

  test("rejects invalid subscription periods and usage", () => {
    for (const value of [
      { ...status, periodEnd: 0 },
      { ...status, periodEnd: 1e30 },
      { ...status, remaining: NaN },
      { ...status, used: -1 },
      { ...status, cancelAtPeriodEnd: "false" },
      { active: false, customer: "true" },
    ]) {
      expect(() => readModelPlanStatus(value)).toThrow("could not load your model plan")
    }
  })

  test("uses reported remaining credits, including zero, and never invents an allowance", () => {
    expect(modelPlanRemaining({ ...status, used: 25 })).toBe(75)
    expect(modelPlanRemaining({ ...status, used: 125 })).toBe(0)
    expect(modelPlanRemaining({ ...status, used: 0, remaining: 0 })).toBe(0)
    expect(modelPlanRemaining({ ...status, remaining: 150 })).toBe(100)
    expect(modelPlanRemaining({ active: false })).toBeUndefined()
  })

  test("purchase requires availability and a confirmed inactive subscription", () => {
    expect(modelPlanPurchasable(config, plan, { active: false })).toBe(true)
    expect(modelPlanPurchasable(config, plan, { active: false, customer: true })).toBe(true)
    expect(modelPlanPurchasable({ ...config, enabled: false }, plan, { active: false })).toBe(false)
    expect(modelPlanPurchasable(config, { ...plan, available: false }, { active: false })).toBe(false)
    expect(modelPlanPurchasable(config, plan, status)).toBe(false)
    expect(modelPlanPurchasable(config, plan, undefined)).toBe(false)
  })

  test("purchased credits work without a subscription and keep unknown usage unknown", () => {
    expect(readModelPlanStatus({ active: false, access: true, wallet: { credits: 8, used: 2, remaining: 6 } })).toEqual(
      { active: false, access: true, wallet: { credits: 8, used: 2, remaining: 6 } },
    )
    expect(readModelPlanStatus({ ...status, access: true, wallet: { credits: 8 } })).toMatchObject({
      active: true,
      wallet: { credits: 8 },
    })
    expect(modelWalletRemaining({ credits: 8 })).toBeUndefined()
    expect(modelWalletRemaining({ credits: 8, used: 2 })).toBe(6)
    expect(modelWalletRemaining({ credits: 8, remaining: 0 })).toBe(0)
    expect(modelWalletRemaining({ credits: 8, used: 10 })).toBe(0)
    for (const wallet of [{ credits: NaN }, { credits: 8, used: -1 }, { credits: 8, remaining: Infinity }]) {
      expect(() => readModelPlanStatus({ active: false, wallet })).toThrow("could not load your model plan")
    }
    expect(modelTopupPurchasable(config, plan, status)).toBe(true)
    expect(modelTopupPurchasable(config, plan, { active: false })).toBe(true)
    expect(modelTopupPurchasable(config, plan, undefined)).toBe(false)
    expect(modelTopupPurchasable({ ...config, enabled: false }, plan, status)).toBe(false)
  })
})

describe("billing redirects", () => {
  test("allows the exact Stripe product origin", () => {
    expect(modelPlanRedirect({ url: "https://checkout.stripe.com/c/pay/cs_test#token" }, "checkout")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test#token",
    )
    expect(modelPlanRedirect({ url: "https://billing.stripe.com/p/session/test" }, "portal")).toBe(
      "https://billing.stripe.com/p/session/test",
    )
    expect(modelPlanRedirect({ url: "https://checkout.stripe.com/c/pay/cs_test" }, "topup")).toBe(
      "https://checkout.stripe.com/c/pay/cs_test",
    )
  })

  test("rejects cross-product, credentialed, deceptive, insecure and malformed redirects", () => {
    for (const url of [
      "https://billing.stripe.com/p/session/test",
      "https://checkout.stripe.com.attacker.example/",
      "https://checkout.stripe.com@attacker.example/",
      "https://user:secret@checkout.stripe.com/",
      "https://checkout.stripe.com:444/",
      "http://checkout.stripe.com/",
      "javascript:alert(1)",
      "/checkout",
      "not a URL",
    ]) {
      expect(() => modelPlanRedirect({ url }, "checkout")).toThrow("could not open billing")
    }
  })
})
