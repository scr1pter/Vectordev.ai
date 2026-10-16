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
import { modelPlanRequest, requireModelPlanContext, streamModelPlanResponse } from "../../../api/_lib/model-plan-chat"
import { verifyModelPlanWebhook } from "../../../api/_lib/model-plan-stripe"
import { IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"

const names = [
  "MODEL_PLANS_ENABLED",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  ...[10, 50, 100, 200].flatMap((price) => [
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
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
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
  test("Codium stays unavailable without private allowance configuration", () => {
    names.forEach((name) => {
      delete process.env[name]
    })
    expect(modelPlans().map((plan) => plan.price)).toEqual([10, 50, 100, 200])
    expect(modelPlans().map((plan) => plan.credits)).toEqual([0, 0, 0, 0])
    expect(modelTopups().map((pack) => pack.credits)).toEqual([0, 0, 0, 0])
    expect(publicModelPlans().plans.every((plan) => !plan.available)).toBe(true)
    expect(publicModelPlans().topups.every((pack) => !pack.available)).toBe(true)
    expect(publicModelPlans().product).toBe("Vector Codium")
    expect(publicModelPlans()).not.toHaveProperty("markupPercent")
    expect(publicModelPlans().models.map((model) => model.id)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "xiaomi/mimo-v2.6-flash",
      "anthropic/claude-haiku-5.5",
    ])
    expect(publicModelPlans().catalogUpdated).toBe("2026-10-10")
    expect(() => requireModelPlans()).toThrow("not available yet")
  })
  test("the public configuration carries no credit amounts, model prices or limits", () => {
    names.forEach((name) => delete process.env[name])
    const config = publicModelPlans()
    for (const offer of [...config.plans, ...config.topups])
      expect(
        Object.keys(offer).every((key) => ["id", "name", "price", "available", "multiple", "tasks"].includes(key)),
      ).toBe(true)
    for (const model of config.models)
      expect(Object.keys(model).every((key) => ["id", "name", "category", "description"].includes(key))).toBe(true)
    const text = JSON.stringify(config)
    for (const key of [
      "credits",
      "inputPrice",
      "outputPrice",
      "contextLength",
      "maxOutputTokens",
      "markupPercent",
      "cached",
    ])
      expect(text).not.toContain(`"${key}":`)
  })
  test("coarse usage ranges are independent of private allowances and prices", () => {
    names.forEach((name) => delete process.env[name])
    const original = publicModelPlans()
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "100"
    process.env.MODEL_PLAN_10_CREDITS_USD = "0.5"
    process.env.MODEL_TOPUP_100_CREDITS_USD = "70"
    expect(publicModelPlans().plans.map((plan) => plan.tasks)).toEqual(original.plans.map((plan) => plan.tasks))
    expect(publicModelPlans().topups.map((plan) => plan.tasks)).toEqual(original.topups.map((plan) => plan.tasks))
    expect(original.plans.map((plan) => plan.multiple)).toEqual([undefined, 5, 10, 20])
    expect(original.plans[0]!.tasks).toEqual([
      [50, 500],
      [80, 800],
      [30, 300],
    ])
  })
  test("markup is configurable and never rounds credits above the purchased allowance", () => {
    names.forEach((name) => delete process.env[name])
    process.env.MODEL_CREDIT_MARKUP_PERCENT = "30"
    expect(modelCreditMarkup()).toBe(30)
    expect(modelPlans()[0].credits).toBe(7.69)
    expect(modelTopups()[3].credits).toBe(153.84)
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
    expect(modelTopups()[3].credits).toBe(133.33)
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
  test("reviewed model routing pins precision, effort and options, and marks Haiku's cache breakpoints", () => {
    const models = configuredPlanModels()
    for (const model of models) {
      const body = modelPlanRequest(
        {
          model: model.id,
          messages: [
            { role: "system", content: "Stable instructions" },
            { role: "system", content: "Per-session context" },
            { role: "user", content: "Fix it" },
            {
              role: "assistant",
              content: null,
              // How both Vector runtimes send earlier reasoning back.
              reasoning_content: "Read the file before editing it.",
              reasoning_details: [
                { type: "reasoning.text", text: "Read the file before editing it.", signature: "sig" },
              ],
              tool_calls: [{ id: "call", type: "function", function: { name: "read", arguments: "{}" } }],
            },
            {
              role: "tool",
              tool_call_id: "call",
              content: [{ type: "text", text: "source", cache_control: { type: "ephemeral", ttl: "1h" } }],
            },
          ],
          tools: [
            {
              type: "function",
              cache_control: { type: "ephemeral", ttl: "1h" },
              function: { name: "read", description: "Read a file", parameters: { type: "object" }, extra: true },
            },
          ],
          tool_choice: "required",
          temperature: 0.2,
          parallel_tool_calls: true,
          reasoning: { effort: "max" },
          provider: { quantizations: ["fp4"] },
        },
        models,
      )
      // No reviewed endpoint takes it, and with require_parameters it would leave none to route to.
      expect(body).not.toHaveProperty("parallel_tool_calls")
      // Thinking models need their earlier reasoning on a tool-call turn; OpenRouter reads it as reasoning.
      expect(body.messages[3]).toMatchObject({
        role: "assistant",
        reasoning: "Read the file before editing it.",
        reasoning_details: [{ type: "reasoning.text", text: "Read the file before editing it.", signature: "sig" }],
      })
      expect(body.messages[3]).not.toHaveProperty("reasoning_content")
      // A tool keeps only its definition.
      expect(body.tools).toEqual([
        { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
      ])
      if (model.id.startsWith("anthropic/")) {
        expect(body.tool_choice).toBe("auto")
        expect(body.reasoning).toEqual({ effort: "high" })
        // Its endpoints refuse sampling options.
        expect(body).not.toHaveProperty("temperature")
        // Vector's stable system block, the whole system prompt, the latest user message and the conversation's end,
        // never a client's own marker.
        expect(
          body.messages.map((message) =>
            Array.isArray(message.content) ? message.content.map((part) => part.cache_control) : undefined,
          ),
        ).toEqual([
          [{ type: "ephemeral" }],
          [{ type: "ephemeral" }],
          [{ type: "ephemeral" }],
          undefined,
          [{ type: "ephemeral" }],
        ])
        expect(JSON.stringify(body)).not.toContain("1h")
        // Naming one tool forces it as surely as required does.
        expect(
          modelPlanRequest(
            {
              model: model.id,
              messages: [{ role: "user", content: "Fix it" }],
              tool_choice: { type: "function", function: { name: "read" } },
            },
            models,
          ).tool_choice,
        ).toBe("auto")
        // Each of these characters can be up to three tokens, so they count by their UTF-8 bytes.
        expect(() =>
          requireModelPlanContext({ ...body, messages: [{ role: "user", content: "界".repeat(34_000) }] }, model),
        ).toThrow()
        expect(() => requireModelPlanContext(body, model)).not.toThrow()
        continue
      }
      expect(body.provider.quantizations).toEqual(["fp8", "bf16"])
      expect(body.tool_choice).toBe("required")
      expect(body).toHaveProperty("temperature", 0.2)
      expect(body.reasoning).toEqual(model.id.startsWith("deepseek/") ? { effort: "high" } : undefined)
      expect(JSON.stringify(body)).not.toContain("cache_control")
    }
  })

  test("refuses earlier reasoning that is not text or a list of reasoning blocks", () => {
    const assistant = { role: "assistant", content: "Done" }
    for (const extra of [
      { reasoning_content: 7 },
      { reasoning: { text: "x" } },
      { reasoning_details: "x" },
      { reasoning_details: [1] },
    ])
      expect(() =>
        modelPlanRequest(
          {
            model: model.id,
            messages: [
              { role: "user", content: "fix" },
              { ...assistant, ...extra },
            ],
          },
          [model],
        ),
      ).toThrow(expect.objectContaining({ code: "MODEL_PLAN_MESSAGE" }))
    // Only an assistant's own turn carries reasoning.
    expect(
      modelPlanRequest(
        {
          model: model.id,
          messages: [{ role: "user", content: "fix", reasoning: "injected", reasoning_details: [{ type: "x" }] }],
        },
        [model],
      ).messages,
    ).toEqual([{ role: "user", content: "fix" }])
  })

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
