import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { paidModelPlan, protectModelPlanKey, revealModelPlanKey } from "../../../api/_lib/model-plan-account"
import {
  modelPlans,
  modelTopups,
  modelCreditMarkup,
  publicModelPlans,
  configuredPlanModels,
  requireModelPlans,
} from "../../../api/_lib/model-plan-config"
import { modelPlanRequest, streamModelPlanResponse } from "../../../api/_lib/model-plan-chat"
import { verifyModelPlanWebhook } from "../../../api/_lib/model-plan-stripe"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

const names = [
  "MODEL_PLANS_ENABLED",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  ...[10, 20, 50, 100, 200].flatMap((price) => [
    `MODEL_PLAN_${price}_CREDITS_USD`,
    `STRIPE_MODEL_PLAN_${price}_PRICE_ID`,
    `MODEL_TOPUP_${price}_CREDITS_USD`,
    `STRIPE_MODEL_TOPUP_${price}_PRICE_ID`,
  ]),
]
const saved = new Map(names.map((name) => [name, process.env[name]]))
afterEach(() =>
  names.forEach((name) => {
    const value = saved.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }),
)

const now = Date.UTC(2026, 9, 9)
const start = Math.floor(now / 1000) - 86400
const end = start + 30 * 86400
const model = {
  id: "fixture/coder",
  name: "Fixture Coder",
  contextLength: 32000,
  maxOutputTokens: 8192,
  inputPrice: 0.1,
  outputPrice: 0.3,
}
function subscription() {
  process.env.STRIPE_MODEL_PLAN_10_PRICE_ID = "price_fixture10"
  process.env.MODEL_PLAN_10_CREDITS_USD = "7"
  return {
    id: "sub_fixture",
    status: "active",
    metadata: { vector_account_id: "account-one" },
    current_period_start: start,
    current_period_end: end,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: "price_fixture10",
            currency: "usd",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      paid: true,
      status: "paid",
      amount_paid: 1000,
      charge: { paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      lines: { data: [{ price: { id: "price_fixture10" }, period: { start, end }, proration: false }] },
    },
  }
}

describe("subscription configuration", () => {
  test("Codium prices use the draft markup and stay unavailable before payment setup", () => {
    names.forEach((name) => {
      delete process.env[name]
    })
    expect(modelPlans().map((plan) => plan.price)).toEqual([10, 20, 50, 100, 200])
    expect(modelPlans().map((plan) => plan.credits)).toEqual([8, 16, 40, 80, 160])
    expect(modelTopups().map((pack) => pack.credits)).toEqual([8, 16, 40, 80, 160])
    expect(publicModelPlans().plans.every((plan) => !plan.available)).toBe(true)
    expect(publicModelPlans().topups.every((pack) => !pack.available)).toBe(true)
    expect(publicModelPlans().product).toBe("Vector Codium")
    expect(publicModelPlans()).not.toHaveProperty("markupPercent")
    expect(publicModelPlans().models.map((model) => model.id)).toEqual([
      "qwen/qwen3-coder-next",
      "minimax/minimax-m3",
      "moonshotai/kimi-k2.7-code",
    ])
    expect(() => requireModelPlans()).toThrow("not available yet")
  })
  test("markup is configurable and never rounds credits above the purchased allowance", () => {
    names.forEach((name) => delete process.env[name])
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "30"
    expect(modelCreditMarkup()).toBe(30)
    expect(modelPlans()[0].credits).toBe(7.69)
    expect(modelTopups()[4].credits).toBe(153.84)
    process.env.MODEL_PLAN_10_CREDITS_USD = "7"
    expect(modelPlans()[0].credits).toBe(7)
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "NaN"
    expect(() => modelTopups()).toThrow()
  })
  test("invalid or unprofitable credit configurations fail closed", () => {
    process.env.MODEL_PLAN_10_CREDITS_USD = "11"
    expect(modelPlans()[0].credits).toBe(0)
    process.env.MODEL_PLAN_10_CREDITS_USD = "NaN"
    expect(modelPlans()[0].credits).toBe(0)
    process.env.MODEL_PLANS_ENABLED = "true"
    expect(publicModelPlans().enabled).toBe(false)
  })
  test("allowances require whole cents without rejecting valid floating-point representations", () => {
    process.env.MODEL_PLAN_10_CREDITS_USD = "7.125"
    process.env.MODEL_TOPUP_10_CREDITS_USD = "7.125"
    expect(modelPlans()[0].credits).toBe(0)
    expect(modelTopups()[0].credits).toBe(0)
    process.env.MODEL_TOPUP_200_CREDITS_USD = "133.33"
    expect(modelTopups()[4].credits).toBe(133.33)
  })
  test("configured paid models require bounded positive pricing and valid context", () => {
    process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([model])
    expect(configuredPlanModels()).toEqual([model])
    for (const invalid of [
      { ...model, inputPrice: 0 },
      { ...model, id: "fixture/coder:free" },
      { ...model, maxOutputTokens: 99999 },
    ]) {
      process.env.MODEL_PLAN_MODELS_JSON = JSON.stringify([invalid])
      expect(() => configuredPlanModels()).toThrow()
    }
  })
})

describe("paid entitlement", () => {
  test("an active account needs a matching paid period and exact configured price", () => {
    const valid = subscription()
    expect(paidModelPlan(valid, "account-one", now)?.plan.credits).toBe(7)
    expect(paidModelPlan(valid, "account-two", now)).toBeUndefined()
    expect(paidModelPlan({ ...valid, status: "past_due" }, "account-one", now)).toBeUndefined()
    expect(paidModelPlan({ ...valid, status: "trialing" }, "account-one", now)).toBeUndefined()
    expect(paidModelPlan({ ...valid, current_period_end: Math.floor(now / 1000) }, "account-one", now)).toBeUndefined()
    valid.items.data[0].price.unit_amount = 100
    expect(paidModelPlan(valid, "account-one", now)).toBeUndefined()
  })
  test("unpaid, refunded, disputed, and old invoices cannot grant fresh credits", () => {
    const value = subscription()
    value.latest_invoice.paid = false
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
    value.latest_invoice.paid = true
    value.latest_invoice.charge.refunded = true
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
    value.latest_invoice.charge.refunded = false
    value.latest_invoice.charge.disputed = true
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
    value.latest_invoice.charge.disputed = false
    value.latest_invoice.lines.data[0].period.end -= 86400
    expect(paidModelPlan(value, "account-one", now)).toBeUndefined()
  })
  test("cancellation at period end preserves the paid remainder", () => {
    const value = subscription()
    value.cancel_at_period_end = true
    expect(paidModelPlan(value, "account-one", now)?.cancelAtPeriodEnd).toBe(true)
    expect(paidModelPlan(value, "account-one", end * 1000)).toBeUndefined()
  })
})

describe("gateway request policy", () => {
  test("preserves bounded retry timing without exposing upstream billing errors", async () => {
    for (const status of [402, 429]) {
      const response = new ServerResponse(new IncomingMessage(new Socket()))
      await expect(
        streamModelPlanResponse(
          Response.json(
            { error: { message: "private billing details" } },
            { status, headers: { "retry-after": "999" } },
          ),
          response,
        ),
      ).rejects.toMatchObject({ statusCode: status })
      expect(response.getHeader("retry-after")).toBe("300")
    }
  })
  test("preserves coding tools but pins model, pricing, privacy, and generation budget", () => {
    const result = modelPlanRequest(
      {
        model: model.id,
        messages: [{ role: "user", content: "fix it", arbitrary: "ignored" }],
        max_tokens: 99999,
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
        provider: { max_price: { completion: 9999 }, zdr: false },
        apiKey: "do-not-forward",
      },
      [model],
    )
    expect(result.max_tokens).toBe(8192)
    expect(result.provider).toEqual({
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 0.1, completion: 0.3, request: 0, image: 0 },
    })
    expect(result.messages).toEqual([{ role: "user", content: "fix it" }])
    expect(result).not.toHaveProperty("apiKey")
    expect(result.plugins.every((plugin) => plugin.enabled === false)).toBe(true)
  })
  test("rejects paid add-ons, model fallback injection and remote media", () => {
    const body = { model: model.id, messages: [{ role: "user", content: "fix" }] }
    expect(() => modelPlanRequest({ ...body, model: "unlisted/expensive" }, [model])).toThrow()
    expect(() => modelPlanRequest({ ...body, models: ["unlisted/expensive"] }, [model])).toThrow()
    expect(() => modelPlanRequest({ ...body, plugins: [{ id: "web" }] }, [model])).toThrow()
    expect(() => modelPlanRequest({ ...body, max_tokens: -1 }, [model])).toThrow()
    expect(() =>
      modelPlanRequest(
        {
          ...body,
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://private.example" } }] }],
        },
        [model],
      ),
    ).toThrow()
  })
})

describe("secrets and billing notifications", () => {
  test("OpenRouter credentials are encrypted and bound to their account and billing period", () => {
    process.env.MODEL_PLAN_KEY_ENCRYPTION_SECRET = "ab".repeat(32)
    const value = protectModelPlanKey("fixture-openrouter-secret", "user:sub:period")
    expect(value).not.toContain("fixture-openrouter-secret")
    expect(revealModelPlanKey(value, "user:sub:period")).toBe("fixture-openrouter-secret")
    expect(() => revealModelPlanKey(value, "other:sub:period")).toThrow()
    expect(() => revealModelPlanKey(value.slice(0, -5), "user:sub:period")).toThrow()
  })
  test("verifies raw-body Stripe signatures and rejects tampering and stale deliveries", () => {
    process.env.STRIPE_MODEL_PLAN_WEBHOOK_SECRET = "whsec_fixture"
    const raw = Buffer.from(JSON.stringify({ id: "evt_fixture", type: "invoice.paid", data: { object: {} } }))
    const timestamp = Math.floor(now / 1000)
    const digest = createHmac("sha256", "whsec_fixture").update(`${timestamp}.`).update(raw).digest("hex")
    const header = `t=${timestamp},v1=${"00".repeat(32)},v1=${digest}`
    expect(verifyModelPlanWebhook(raw, header, now).type).toBe("invoice.paid")
    expect(() => verifyModelPlanWebhook(Buffer.from("{}"), header, now)).toThrow()
    expect(() => verifyModelPlanWebhook(raw, header, now + 301000)).toThrow()
    expect(() => verifyModelPlanWebhook(raw, `t=${timestamp},v1=bad`, now)).toThrow()
  })
})
