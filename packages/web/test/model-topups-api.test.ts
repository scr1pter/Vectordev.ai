import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cancelModelPlanAccount,
  modelPlanCredential,
  modelPlanStatus,
  modelTopupCheckout,
  readModelPlanAccount,
  reconcileModelTopup,
} from "../../../api/_lib/model-plan-account"
import { reconcileModelPlanEvent } from "../../../api/model-plans/webhook"
import { stripeRecord } from "../../../api/_lib/model-plan-stripe"

const directory = await mkdtemp(join(tmpdir(), "codium-topup-test-"))
const socket = join(directory, "redis.sock")
const processHandle = Bun.spawn(
  [
    process.env.VECTOR_TEST_VALKEY_SERVER ?? "valkey-server",
    "--port",
    "0",
    "--unixsocket",
    socket,
    "--save",
    "",
    "--appendonly",
    "no",
    "--dir",
    directory,
  ],
  { stdout: "ignore", stderr: "pipe" },
)
async function redis(command: readonly (string | number)[]) {
  const child = Bun.spawn(
    [process.env.VECTOR_TEST_VALKEY_CLI ?? "valkey-cli", "-s", socket, "--json", ...command.map(String)],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(child.stdout).text()
  if (await child.exited) throw new Error(await new Response(child.stderr).text())
  return JSON.parse(output) as unknown
}
const user = { id: "33333333-3333-4333-8333-333333333333", email: "wallet@example.test" }
const accountKey = `vector:model-plans:account:${user.id}`
const sessions = new Map<string, Record<string, unknown>>()
const payments = new Map<string, Record<string, unknown>>()
const keys = new Map<string, { key: string; data: Record<string, unknown> }>()
const idempotency = new Map<string, Record<string, unknown>>()
const state = {
  loseCheckout: false,
  failSave: false,
  delayKey: 0,
  subscriptions: [] as Record<string, unknown>[],
  disputes: [] as Record<string, unknown>[],
}
const environment = [
  "NODE_ENV",
  "VERCEL_ENV",
  "MODEL_PLANS_ENABLED",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "STRIPE_SECRET_KEY",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "OPENROUTER_MANAGEMENT_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  ...[10, 20, 50, 100, 200].flatMap((price) => [
    `STRIPE_MODEL_TOPUP_${price}_PRICE_ID`,
    `MODEL_TOPUP_${price}_CREDITS_USD`,
    `STRIPE_MODEL_PLAN_${price}_PRICE_ID`,
    `MODEL_PLAN_${price}_CREDITS_USD`,
  ]),
]
const previous = new Map(environment.map((key) => [key, process.env[key]]))
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/redis") {
      const command: unknown = await request.json()
      if (!Array.isArray(command)) throw new Error("Invalid Redis command")
      if (
        state.failSave &&
        command[0] === "SET" &&
        command[1] === accountKey &&
        String(command[2]).includes('"purchases":')
      )
        return new Response(null, { status: 503 })
      return Response.json({ result: await redis(command) })
    }
    const body =
      request.method === "GET"
        ? {}
        : request.headers.get("content-type")?.includes("json")
          ? ((await request.json()) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(await request.text()))
    if (url.pathname === "/v1/customers") return Response.json({ id: "cus_wallet" })
    if (url.pathname === "/v1/customers/cus_wallet")
      return Response.json({ id: "cus_wallet", metadata: { vector_account_id: user.id } })
    if (url.pathname === "/v1/subscriptions") return Response.json({ data: state.subscriptions, has_more: false })
    if (url.pathname === "/v1/disputes") return Response.json({ data: state.disputes, has_more: false })
    if (url.pathname.startsWith("/v1/prices/"))
      return Response.json({
        active: true,
        currency: "usd",
        unit_amount: Number(url.pathname.match(/(\d+)$/)?.[1]) * 100,
        recurring: null,
      })
    if (url.pathname === "/v1/checkout/sessions") {
      if (request.method === "GET")
        return Response.json({
          data: [...sessions.values()].filter((value) => value.status === "open"),
          has_more: false,
        })
      const token = request.headers.get("idempotency-key")!
      if (idempotency.has(token)) return Response.json(idempotency.get(token))
      const metadata = Object.fromEntries(
        Object.entries(body)
          .filter(([key]) => key.startsWith("metadata["))
          .map(([key, value]) => [key.slice(9, -1), value]),
      )
      const amount = Number(String(body["line_items[0][price]"]).match(/(\d+)$/)?.[1]) * 100
      const session = {
        id: `cs_wallet${sessions.size + 1}`,
        customer: body.customer,
        client_reference_id: body.client_reference_id,
        mode: body.mode,
        status: "open",
        payment_status: "unpaid",
        amount_total: amount,
        currency: "usd",
        metadata,
        url: `https://checkout.stripe.com/c/pay/cs_wallet${sessions.size + 1}`,
        expires_at: Number(body.expires_at),
        line_items: {
          data: [
            {
              quantity: 1,
              price: { id: body["line_items[0][price]"], currency: "usd", unit_amount: amount, recurring: null },
            },
          ],
        },
      }
      sessions.set(session.id, session)
      idempotency.set(token, session)
      if (state.loseCheckout) {
        state.loseCheckout = false
        return new Response(null, { status: 503 })
      }
      return Response.json(session)
    }
    if (url.pathname.startsWith("/v1/checkout/sessions/")) {
      const session = sessions.get(url.pathname.split("/")[4]!)
      if (!session) return new Response(null, { status: 404 })
      if (url.pathname.endsWith("/expire")) session.status = "expired"
      return Response.json(session)
    }
    if (url.pathname.startsWith("/v1/payment_intents/"))
      return Response.json(payments.get(url.pathname.split("/").at(-1)!))
    if (url.pathname.startsWith("/v1/charges/"))
      return Response.json({ id: url.pathname.split("/").at(-1), customer: "cus_wallet" })
    if (url.pathname.startsWith("/api/v1/keys")) {
      if (request.method === "POST") {
        const hash = `wallet_key_${keys.size + 1}`
        const value = { key: `wallet-secret-${keys.size + 1}`, data: { ...body, hash, usage: 0, disabled: false } }
        keys.set(hash, value)
        return Response.json(value)
      }
      const value = keys.get(url.pathname.split("/").at(-1)!)
      if (!value) return new Response(null, { status: 404 })
      if (request.method === "PATCH") Object.assign(value.data, body)
      if (state.delayKey) await Bun.sleep(state.delayKey)
      return Response.json({ data: value.data })
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  },
})
const fetcher: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (["https://api.stripe.com", "https://openrouter.ai"].includes(url.origin))
      return fetch(new URL(url.pathname + url.search, server.url), init)
    if (url.origin === server.url.origin) return fetch(input, init)
    throw new Error(`Unexpected network destination ${url.origin}`)
  },
  { preconnect: fetch.preconnect },
)

beforeAll(async () => {
  for (let count = 0; count < 300 && !(await stat(socket).catch(() => undefined)); count++) await Bun.sleep(10)
  expect(await redis(["PING"])).toBe("PONG")
})
beforeEach(async () => {
  await redis(["FLUSHDB"])
  sessions.clear()
  payments.clear()
  keys.clear()
  idempotency.clear()
  Object.assign(state, { loseCheckout: false, failSave: false, delayKey: 0, subscriptions: [], disputes: [] })
  Object.assign(process.env, {
    NODE_ENV: "development",
    MODEL_PLANS_ENABLED: "true",
    MODEL_CREDIT_MARKUP_PERCENT: "25",
    STRIPE_SECRET_KEY: "fixture",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "ef".repeat(32),
    OPENROUTER_MANAGEMENT_KEY: "fixture",
    KV_REST_API_URL: new URL("/redis", server.url).href,
    KV_REST_API_TOKEN: "fixture",
  })
  delete process.env.VERCEL_ENV
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  for (const price of [10, 20, 50, 100, 200]) {
    process.env[`STRIPE_MODEL_TOPUP_${price}_PRICE_ID`] = `price_topup${price}`
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_monthly${price}`
    delete process.env[`MODEL_TOPUP_${price}_CREDITS_USD`]
    delete process.env[`MODEL_PLAN_${price}_CREDITS_USD`]
  }
})
afterAll(async () => {
  server.stop(true)
  processHandle.kill()
  await processHandle.exited
  await rm(directory, { recursive: true, force: true })
  previous.forEach((value, key) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})
async function purchase(price = 10) {
  await modelTopupCheckout(user, `codium-topup-${price}`, fetcher)
  const checkout = [...sessions.values()].at(-1)!
  const metadata = stripeRecord(checkout.metadata) ? checkout.metadata : {}
  const payment = {
    id: `pi_wallet${payments.size + 1}`,
    customer: "cus_wallet",
    currency: "usd",
    status: "succeeded",
    amount: price * 100,
    amount_received: price * 100,
    metadata,
    latest_charge: { paid: true, disputed: false, currency: "usd", amount: price * 100, amount_refunded: 0 },
  }
  payments.set(payment.id, payment)
  Object.assign(checkout, { status: "complete", payment_status: "paid", payment_intent: payment })
  return { checkout, payment }
}

function monthly() {
  const start = Math.floor(Date.now() / 1000) - 1000
  const end = start + 10000
  return {
    id: "sub_wallet",
    status: "active",
    metadata: { vector_account_id: user.id },
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: "price_monthly10",
            currency: "usd",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1 },
          },
          current_period_start: start,
          current_period_end: end,
        },
      ],
    },
    latest_invoice: {
      paid: true,
      status: "paid",
      amount_paid: 1000,
      charge: { id: "ch_monthly", paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      lines: { data: [{ price: { id: "price_monthly10" }, period: { start, end }, proration: false }] },
    },
  }
}

test("top-up checkout works without a subscription and reuses or replaces only pending pack checkout", async () => {
  const first = await modelTopupCheckout(user, "codium-topup-10", fetcher)
  expect(await modelTopupCheckout(user, "codium-topup-10", fetcher)).toEqual(first)
  expect(await modelTopupCheckout(user, "codium-topup-20", fetcher)).not.toEqual(first)
  expect(sessions.get("cs_wallet1")?.status).toBe("expired")
  expect(sessions.size).toBe(2)
})

test("replaces a pending top-up checkout when its allowance or Stripe price changes", async () => {
  const first = await modelTopupCheckout(user, "codium-topup-10", fetcher)
  process.env.MODEL_CREDIT_MARKUP_PERCENT = "50"
  const second = await modelTopupCheckout(user, "codium-topup-10", fetcher)
  expect(second.url).not.toBe(first.url)
  expect(sessions.get("cs_wallet1")?.status).toBe("expired")
  expect(sessions.get("cs_wallet2")?.metadata).toMatchObject({ vector_credits_usd: "6.66" })
  process.env.STRIPE_MODEL_TOPUP_10_PRICE_ID = "price_repriced10"
  const third = await modelTopupCheckout(user, "codium-topup-10", fetcher)
  expect(third.url).not.toBe(second.url)
  expect(sessions.get("cs_wallet2")?.status).toBe("expired")
  expect(sessions.get("cs_wallet3")?.metadata).toMatchObject({ vector_price_id: "price_repriced10" })
  expect(await modelTopupCheckout(user, "codium-topup-10", fetcher)).toEqual(third)
}, 30_000)

test("an ambiguous checkout response retries the same Stripe session", async () => {
  state.loseCheckout = true
  await expect(modelTopupCheckout(user, "codium-topup-10", fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
  await modelTopupCheckout(user, "codium-topup-10", fetcher)
  expect(sessions.size).toBe(1)
})

test("paid top-ups unlock standalone inference, retain encrypted keys, and do not duplicate grants", async () => {
  const bought = await purchase()
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({
    active: false,
    access: true,
    wallet: { credits: 8, used: 0, remaining: 8 },
  })
  await reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)
  await reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)
  const key = await modelPlanCredential(user.id, fetcher)
  expect(key).toBe("wallet-secret-1")
  expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
    purchases: [{ credits: 8, payment: bought.payment.id }],
  })
  expect(JSON.stringify(await readModelPlanAccount(user.id, fetcher))).not.toContain(key)
  expect(keys.get("wallet_key_1")?.data).toMatchObject({
    limit: 8,
    limit_reset: null,
    expires_at: null,
    include_byok_in_limit: true,
  })
  keys.get("wallet_key_1")!.data.usage = 2
  process.env.MODEL_CREDIT_MARKUP_PERCENT = "100"
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ wallet: { credits: 8, used: 2, remaining: 6 } })
})

test("a second completed purchase increases the same lifetime cap without clearing usage", async () => {
  await purchase()
  await modelPlanCredential(user.id, fetcher)
  keys.get("wallet_key_1")!.data.usage = 7
  const next = await purchase(20)
  await reconcileModelTopup(user.id, String(next.checkout.id), fetcher)
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-1")
  expect(keys.size).toBe(1)
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 24, usage: 7 })
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ wallet: { credits: 24, used: 7, remaining: 17 } })
})

test("partial refunds reduce credits proportionally and disputes preserve spent-credit debt", async () => {
  const bought = await purchase()
  await modelPlanCredential(user.id, fetcher)
  keys.get("wallet_key_1")!.data.usage = 6
  bought.payment.latest_charge.amount_refunded = 500
  await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_TOPUP_EXHAUSTED" })
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 4, disabled: true, usage: 6 })
  const next = await purchase()
  await reconcileModelTopup(user.id, String(next.checkout.id), fetcher)
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ wallet: { credits: 12, used: 6, remaining: 6 } })
  bought.payment.latest_charge.disputed = true
  await reconcileModelPlanEvent({ type: "charge.dispute.created", data: { object: { charge: "ch_wallet1" } } }, fetcher)
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 8, usage: 6 })
  state.disputes = [{ payment_intent: bought.payment.id, status: "won" }]
  bought.payment.latest_charge.amount_refunded = 0
  await reconcileModelPlanEvent({ type: "charge.dispute.closed", data: { object: { charge: "ch_wallet1" } } }, fetcher)
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 16, usage: 6 })
})

test("unpaid, underpaid, and cross-account checkouts never grant credits", async () => {
  const bought = await purchase()
  bought.checkout.payment_status = "unpaid"
  await expect(reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)).rejects.toMatchObject({
    code: "MODEL_TOPUP_PAYMENT_INVALID",
  })
  bought.checkout.payment_status = "paid"
  bought.payment.amount_received = 999
  await expect(reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)).rejects.toMatchObject({
    code: "MODEL_TOPUP_PAYMENT_INVALID",
  })
  bought.payment.amount_received = 1000
  bought.checkout.client_reference_id = "another-account"
  await expect(reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)).rejects.toMatchObject({
    code: "MODEL_TOPUP_PAYMENT_INVALID",
  })
  expect((await readModelPlanAccount(user.id, fetcher))?.purchases).toBeUndefined()
  expect(keys.size).toBe(0)
})

test("monthly allowance is selected first and wallet handles a request too large for monthly remaining", async () => {
  await purchase()
  state.subscriptions = [monthly()]
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-1")
  keys.get("wallet_key_1")!.data.usage = 7.9
  expect(await modelPlanCredential(user.id, fetcher, Date.now(), 0.2)).toBe("wallet-secret-2")
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 8, usage: 7.9 })
  expect(keys.get("wallet_key_2")?.data).toMatchObject({ limit: 8, usage: 0, expires_at: null })
  state.subscriptions = []
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-2")
  expect(keys.get("wallet_key_1")?.data.disabled).toBe(true)
})

test("failure saving a grant does not expose credits and retry grants exactly once", async () => {
  const bought = await purchase()
  state.failSave = true
  await expect(reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)).rejects.toMatchObject({
    code: "PERSISTENT_STORE_UNAVAILABLE",
  })
  expect(keys.size).toBe(0)
  state.failSave = false
  await reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)
  await reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)
  expect((await readModelPlanAccount(user.id, fetcher))?.purchases).toHaveLength(1)
})

test("account deletion disables both funding keys, closes pending top-ups, and prevents reuse", async () => {
  await purchase()
  await modelPlanCredential(user.id, fetcher)
  await modelTopupCheckout(user, "codium-topup-20", fetcher)
  await cancelModelPlanAccount(user.id, fetcher)
  expect(keys.get("wallet_key_1")?.data.disabled).toBe(true)
  expect(sessions.get("cs_wallet2")?.status).toBe("expired")
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ active: false, access: false })
  await expect(modelTopupCheckout(user, "codium-topup-10", fetcher)).rejects.toMatchObject({
    code: "MODEL_PLAN_ACCOUNT_CLOSING",
  })
  await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_ACCOUNT_CLOSING" })
})

test("parallel wallet requests reuse the key without taking provisioning leases", async () => {
  await purchase()
  await modelPlanCredential(user.id, fetcher)
  state.delayKey = 75
  const results = await Promise.all(Array.from({ length: 8 }, () => modelPlanCredential(user.id, fetcher)))
  expect(results).toEqual(Array.from({ length: 8 }, () => "wallet-secret-1"))
  expect(keys.size).toBe(1)
})

test("concurrent duplicate grant attempts cannot mint a second allowance", async () => {
  const bought = await purchase()
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)),
  )
  expect(results.some((result) => result.status === "fulfilled")).toBe(true)
  expect((await readModelPlanAccount(user.id, fetcher))?.purchases).toHaveLength(1)
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ wallet: { credits: 8, remaining: 8 } })
})

test("renewing a monthly allowance does not roll over old monthly credits or reset purchased usage", async () => {
  await purchase()
  await modelPlanCredential(user.id, fetcher)
  keys.get("wallet_key_1")!.data.usage = 2
  state.subscriptions = [monthly()]
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-2")
  keys.get("wallet_key_2")!.data.usage = 4
  const renewal = monthly()
  renewal.items.data[0]!.current_period_start += 100
  renewal.items.data[0]!.current_period_end += 100
  renewal.latest_invoice.lines.data[0]!.period.start += 100
  renewal.latest_invoice.lines.data[0]!.period.end += 100
  state.subscriptions = [renewal]
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-3")
  expect(keys.get("wallet_key_2")?.data.disabled).toBe(true)
  expect(keys.get("wallet_key_3")?.data).toMatchObject({ limit: 8, usage: 0 })
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({
    credits: 8,
    used: 0,
    wallet: { credits: 8, used: 2, remaining: 6 },
  })
})

test("missing provider usage fails closed instead of granting a new lifetime key", async () => {
  await purchase()
  await modelPlanCredential(user.id, fetcher)
  delete keys.get("wallet_key_1")!.data.usage
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({
    access: false,
    wallet: { credits: 8, used: undefined, remaining: undefined },
  })
  await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_KEY_INVALID" })
  expect(keys.size).toBe(1)
})

test("out-of-order completion after refund reads the current charge instead of regranting credits", async () => {
  const bought = await purchase()
  await modelPlanCredential(user.id, fetcher)
  bought.payment.latest_charge.amount_refunded = 1000
  const event = { type: "checkout.session.completed", data: { object: bought.checkout } }
  await reconcileModelPlanEvent(event, fetcher)
  await reconcileModelPlanEvent(event, fetcher)
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 0, disabled: true })
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ access: false, wallet: { credits: 0, remaining: 0 } })
  expect((await readModelPlanAccount(user.id, fetcher))?.purchases).toHaveLength(1)
})

test("cent-denominated credit snapshots survive floating-point representation", async () => {
  process.env.MODEL_CREDIT_MARKUP_PERCENT = "50"
  const bought = await purchase(200)
  await reconcileModelTopup(user.id, String(bought.checkout.id), fetcher)
  expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ wallet: { credits: 133.33, remaining: 133.33 } })
})

test("historically disputed charges restore credits only after an authoritative merchant win", async () => {
  const bought = await purchase()
  await modelPlanCredential(user.id, fetcher)
  keys.get("wallet_key_1")!.data.usage = 2
  bought.payment.latest_charge.disputed = true
  for (const status of ["needs_response", "under_review", "lost", "unknown"]) {
    state.disputes = [{ payment_intent: bought.payment.id, status }]
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_TOPUP_EXHAUSTED" })
  }
  state.disputes = [{ payment_intent: "another-payment", status: "won" }]
  await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_TOPUP_EXHAUSTED" })
  state.disputes = [{ payment_intent: bought.payment.id, status: "won" }]
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-1")
  expect(bought.payment.latest_charge.disputed).toBe(true)
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 8, usage: 2, disabled: false })
})

test("monthly dispute recovery reuses the paid period and preserves charged usage", async () => {
  await redis(["SET", accountKey, JSON.stringify({ customer: "cus_wallet" })])
  const subscription = monthly()
  state.subscriptions = [subscription]
  await modelPlanCredential(user.id, fetcher)
  keys.get("wallet_key_1")!.data.usage = 2
  subscription.latest_invoice.charge.disputed = true
  state.disputes = [{ charge: "ch_monthly", status: "under_review" }]
  await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
  expect(keys.get("wallet_key_1")?.data.disabled).toBe(true)
  state.disputes = [{ charge: "ch_monthly", status: "won" }]
  expect(await modelPlanCredential(user.id, fetcher)).toBe("wallet-secret-1")
  expect(keys.get("wallet_key_1")?.data).toMatchObject({ limit: 8, usage: 2, disabled: false })
  expect(subscription.latest_invoice.charge.disputed).toBe(true)
})
