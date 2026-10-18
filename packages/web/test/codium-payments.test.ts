import { RedisClient } from "bun"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCodiumFunding, CODIUM_FUNDING_MAX_AGE_MS, readCodiumFunding } from "../../../api/_lib/codium-funding"
import {
  codiumLedger,
  codiumLedgerSummary,
  handleCodiumLedger,
  recordCodiumCharge,
} from "../../../api/_lib/codium-ledger"
import {
  modelPlanCheckout,
  modelPlanCredential,
  modelTopupCheckout,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../../../api/_lib/model-plan-account"
import { verifyModelPlanWebhook } from "../../../api/_lib/model-plan-stripe"
import { reconcileModelPlanEvent } from "../../../api/model-plans/webhook"

// The money pipeline end to end against local fakes: Stripe, OpenRouter and Resend are one local HTTP server, and
// leases, accounts and the ledger live in a real, isolated Valkey database.
const directory = await mkdtemp(join(tmpdir(), "codium-payments-test-"))
// A spawned Valkey listens on a free local port so the native client, not a process per command, talks to it.
const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
const port = probe.port
probe.stop(true)
const processHandle = process.env.VECTOR_TEST_REDIS_URL
  ? undefined
  : Bun.spawn(
      [
        process.env.VECTOR_TEST_VALKEY_SERVER ?? "valkey-server",
        "--port",
        String(port),
        "--bind",
        "127.0.0.1",
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        directory,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
const database = new RedisClient(process.env.VECTOR_TEST_REDIS_URL ?? `redis://127.0.0.1:${port}`)
const redis = (command: readonly (string | number)[]) =>
  database.send(String(command[0]), command.slice(1).map(String)) as Promise<unknown>

const user = { id: "44444444-4444-4444-8444-444444444444", email: "buyer@example.test" }
const accountKey = `vector:model-plans:account:${user.id}`
const DAY = 86_400

type Charge = {
  id: string
  customer: string
  amount: number
  amount_refunded: number
  currency: string
  paid: boolean
  refunded: boolean
  disputed: boolean
  created: number
  balance_transaction: {
    id: string
    amount: number
    fee: number
    net: number
    currency?: string
    exchange_rate?: number
  } | null
  refunds: { data: { amount: number; balance_transaction: { fee: number; net: number } }[]; has_more: boolean }
  payment_intent: string | null
  invoice: string | null
}
const stripe = {
  charges: new Map<string, Charge>(),
  invoices: new Map<string, Record<string, unknown> & { charge: string | null }>(),
  payments: new Map<string, Record<string, unknown>>(),
  sessions: new Map<string, Record<string, unknown>>(),
  subscriptions: [] as Record<string, unknown>[],
  disputes: [] as Record<string, unknown>[],
  idempotency: new Map<string, Record<string, unknown>>(),
}
const openRouter = {
  keys: new Map<string, { key: string; data: Record<string, unknown> }>(),
  credits: { total_credits: 0, total_usage: 0 },
  unavailable: false,
  pageSize: 2,
  ignoreOffset: false,
}
const emails: Record<string, unknown>[] = []
const resend = { failing: false }

const environment = [
  "NODE_ENV",
  "VERCEL_ENV",
  "MODEL_PLANS_ENABLED",
  "MODEL_CREDIT_MARKUP_PERCENT",
  "STRIPE_SECRET_KEY",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  "STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "OPENROUTER_MANAGEMENT_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "RESEND_API_KEY",
  "VECTOR_PURCHASE_EMAIL_FROM",
  "CODIUM_OWNER_EMAIL",
  "CODIUM_OWNER_SECRET",
  "CODIUM_FUNDING_MARGIN_PERCENT",
  "CODIUM_FUNDING_MARGIN_USD",
  "CODIUM_OPENROUTER_FEE_PERCENT",
  "CRON_SECRET",
  "VECTOR_CLI_TOKEN_SECRET",
  ...[10, 50, 100, 200].flatMap((price) => [
    `STRIPE_MODEL_TOPUP_${price}_PRICE_ID`,
    `MODEL_TOPUP_${price}_CREDITS_USD`,
    `STRIPE_MODEL_PLAN_${price}_PRICE_ID`,
    `MODEL_PLAN_${price}_CREDITS_USD`,
  ]),
]
const previous = new Map(environment.map((key) => [key, process.env[key]]))

function expandedCharge(id: string | null) {
  const charge = id ? stripe.charges.get(id) : undefined
  return charge ? { ...charge } : null
}
function expandedInvoice(id: string | null) {
  const invoice = id ? stripe.invoices.get(id) : undefined
  return invoice ? { ...invoice, charge: expandedCharge(invoice.charge) } : null
}
function expandedSubscription(value: Record<string, unknown>) {
  return { ...value, latest_invoice: expandedInvoice(String(value.latest_invoice)) }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/redis") {
      const command: unknown = await request.json()
      if (!Array.isArray(command)) throw new Error("Invalid Redis command")
      return Response.json({ result: await redis(command) })
    }
    const body =
      request.method === "GET"
        ? {}
        : request.headers.get("content-type")?.includes("json")
          ? ((await request.json()) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(await request.text()))
    if (url.pathname === "/emails") {
      expect(request.headers.get("authorization")).toBe("Bearer re_fixture")
      if (resend.failing) return Response.json({ message: "fixture outage" }, { status: 503 })
      emails.push(body)
      return Response.json({ id: `email_${emails.length}` })
    }
    if (url.pathname.startsWith("/v1/")) {
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_fixture")
      const parts = url.pathname.split("/")
      if (url.pathname === "/v1/customers") return Response.json({ id: "cus_buyer" })
      if (url.pathname === "/v1/customers/cus_buyer")
        return Response.json({ id: "cus_buyer", metadata: { vector_account_id: user.id } })
      if (url.pathname === "/v1/subscriptions")
        return Response.json({ data: stripe.subscriptions.map(expandedSubscription), has_more: false })
      if (url.pathname === "/v1/disputes")
        return Response.json({
          data: stripe.disputes.filter(
            (value) =>
              (!url.searchParams.get("charge") || value.charge === url.searchParams.get("charge")) &&
              (!url.searchParams.get("payment_intent") ||
                value.payment_intent === url.searchParams.get("payment_intent")),
          ),
          has_more: false,
        })
      if (url.pathname.startsWith("/v1/prices/"))
        return Response.json({
          active: true,
          currency: "usd",
          unit_amount: Number(url.pathname.match(/(\d+)$/)?.[1]) * 100,
          recurring: url.pathname.includes("monthly") ? { interval: "month", interval_count: 1 } : null,
        })
      if (url.pathname === "/v1/checkout/sessions") {
        if (request.method === "GET")
          return Response.json({
            data: [...stripe.sessions.values()].filter((value) => value.status === "open"),
            has_more: false,
          })
        const token = request.headers.get("idempotency-key")!
        if (stripe.idempotency.has(token)) return Response.json(stripe.idempotency.get(token))
        const metadata = Object.fromEntries(
          Object.entries(body)
            .filter(([key]) => key.startsWith("metadata["))
            .map(([key, value]) => [key.slice(9, -1), value]),
        )
        const amount = Number(String(body["line_items[0][price]"]).match(/(\d+)$/)?.[1]) * 100
        const session = {
          id: `cs_buyer${stripe.sessions.size + 1}`,
          customer: body.customer,
          client_reference_id: body.client_reference_id,
          mode: body.mode,
          status: "open",
          payment_status: "unpaid",
          amount_total: amount,
          currency: "usd",
          metadata,
          url: `https://checkout.stripe.com/c/pay/cs_buyer${stripe.sessions.size + 1}`,
          expires_at: Number(body.expires_at),
          payment_intent: null as string | null,
          line_items: {
            data: [
              {
                quantity: 1,
                price: { id: body["line_items[0][price]"], currency: "usd", unit_amount: amount, recurring: null },
              },
            ],
          },
        }
        stripe.sessions.set(session.id, session)
        stripe.idempotency.set(token, session)
        return Response.json(session)
      }
      if (url.pathname.startsWith("/v1/checkout/sessions/")) {
        const session = stripe.sessions.get(parts[4]!)
        if (!session) return new Response(null, { status: 404 })
        if (url.pathname.endsWith("/expire")) session.status = "expired"
        const payment = typeof session.payment_intent === "string" ? stripe.payments.get(session.payment_intent) : null
        return Response.json({
          ...session,
          payment_intent: payment ? { ...payment, latest_charge: expandedCharge(String(payment.latest_charge)) } : null,
        })
      }
      if (url.pathname.startsWith("/v1/payment_intents/")) {
        const payment = stripe.payments.get(parts[3]!)
        if (!payment) return new Response(null, { status: 404 })
        return Response.json({ ...payment, latest_charge: expandedCharge(String(payment.latest_charge)) })
      }
      if (url.pathname.startsWith("/v1/charges/")) {
        const charge = stripe.charges.get(parts[3]!)
        if (!charge) return new Response(null, { status: 404 })
        const invoice = charge.invoice ? stripe.invoices.get(charge.invoice) : undefined
        const subscription = invoice
          ? stripe.subscriptions.find((value) => value.id === invoice.subscription)
          : undefined
        return Response.json({
          ...charge,
          payment_intent: charge.payment_intent ? (stripe.payments.get(charge.payment_intent) ?? null) : null,
          invoice: invoice ? { ...invoice, subscription: subscription ?? invoice.subscription } : null,
        })
      }
    }
    if (url.pathname === "/api/v1/credits") {
      expect(request.headers.get("authorization")).toBe("Bearer or_management_fixture")
      if (openRouter.unavailable) return new Response(null, { status: 503 })
      return Response.json({ data: openRouter.credits })
    }
    if (url.pathname.startsWith("/api/v1/keys")) {
      expect(request.headers.get("authorization")).toBe("Bearer or_management_fixture")
      if (openRouter.unavailable) return new Response(null, { status: 503 })
      if (url.pathname === "/api/v1/keys" && request.method === "GET") {
        const offset = openRouter.ignoreOffset ? 0 : Number(url.searchParams.get("offset") ?? 0)
        const listed = [...openRouter.keys.values()].map((value) => value.data).filter((value) => !value.disabled)
        return Response.json({ data: listed.slice(offset, offset + openRouter.pageSize) })
      }
      if (request.method === "POST") {
        const hash = `codium_key_${openRouter.keys.size + 1}`
        const value = {
          key: `codium-secret-${openRouter.keys.size + 1}`,
          data: { ...body, hash, usage: 0, disabled: false },
        }
        openRouter.keys.set(hash, value)
        return Response.json(value)
      }
      const value = openRouter.keys.get(url.pathname.split("/").at(-1)!)
      if (!value) return new Response(null, { status: 404 })
      if (request.method === "PATCH") Object.assign(value.data, body)
      return Response.json({ data: value.data })
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  },
})
const fetcher: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (["https://api.stripe.com", "https://openrouter.ai", "https://api.resend.com"].includes(url.origin))
      return fetch(new URL(url.pathname + url.search, server.url), init)
    if (url.origin === server.url.origin) return fetch(input, init)
    throw new Error(`Unexpected network destination ${url.origin}`)
  },
  { preconnect: fetch.preconnect },
)

beforeAll(async () => {
  for (let count = 0; count < 300 && !(await redis(["PING"]).catch(() => undefined)); count++) await Bun.sleep(10)
  expect(await redis(["PING"])).toBe("PONG")
})
beforeEach(async () => {
  await redis(["FLUSHDB"])
  stripe.charges.clear()
  stripe.invoices.clear()
  stripe.payments.clear()
  stripe.sessions.clear()
  stripe.idempotency.clear()
  stripe.subscriptions = []
  stripe.disputes = []
  openRouter.keys.clear()
  Object.assign(openRouter, {
    credits: { total_credits: 1000, total_usage: 0 },
    unavailable: false,
    pageSize: 2,
    ignoreOffset: false,
  })
  emails.length = 0
  resend.failing = false
  Object.assign(process.env, {
    NODE_ENV: "development",
    MODEL_PLANS_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
    OPENROUTER_MANAGEMENT_KEY: "or_management_fixture",
    KV_REST_API_URL: new URL("/redis", server.url).href,
    KV_REST_API_TOKEN: "fixture",
    RESEND_API_KEY: "re_fixture",
    VECTOR_PURCHASE_EMAIL_FROM: "Vector <support@example.test>",
    CODIUM_OWNER_EMAIL: "owner@example.test",
    CODIUM_OWNER_SECRET: "owner-fixture-secret-".repeat(3),
    CRON_SECRET: "cron-fixture-secret",
  })
  for (const key of [
    "VERCEL_ENV",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "MODEL_CREDIT_MARKUP_PERCENT",
    "CODIUM_FUNDING_MARGIN_PERCENT",
    "CODIUM_FUNDING_MARGIN_USD",
    "CODIUM_OPENROUTER_FEE_PERCENT",
  ])
    delete process.env[key]
  for (const price of [10, 50, 100, 200]) {
    process.env[`STRIPE_MODEL_TOPUP_${price}_PRICE_ID`] = `price_topup${price}`
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_monthly${price}`
    // Fixture allowances only, unrelated to any live conversion.
    process.env[`MODEL_TOPUP_${price}_CREDITS_USD`] = String(price / 2)
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = String(price / 2)
  }
})
afterAll(async () => {
  server.stop(true)
  database.close()
  processHandle?.kill()
  await processHandle?.exited
  await rm(directory, { recursive: true, force: true })
  previous.forEach((value, key) => {
    delete process.env[key]
    if (value !== undefined) process.env[key] = value
  })
})

let sequence = 0
function charge(input: Partial<Charge> & { amount: number }) {
  sequence += 1
  const fee = Math.round(input.amount * 0.029) + 30
  const value: Charge = {
    id: `ch_buyer${sequence}`,
    customer: "cus_buyer",
    amount_refunded: 0,
    currency: "usd",
    paid: true,
    refunded: false,
    disputed: false,
    created: Math.floor(Date.UTC(2026, 9, 17) / 1000),
    balance_transaction: { id: `txn_buyer${sequence}`, amount: input.amount, fee, net: input.amount - fee },
    refunds: { data: [], has_more: false },
    payment_intent: null,
    invoice: null,
    ...input,
  }
  stripe.charges.set(value.id, value)
  return value
}

/** A paid monthly subscription, as Stripe holds it after checkout or a renewal. */
function subscribe(price = 10, start = Math.floor(Date.now() / 1000) - 3600) {
  const end = start + 30 * DAY
  const paid = charge({ amount: price * 100 })
  const invoice = {
    id: `in_buyer${sequence}`,
    customer: "cus_buyer",
    subscription: "sub_buyer",
    paid: true,
    status: "paid",
    amount_paid: price * 100,
    charge: paid.id,
    lines: { data: [{ price: { id: `price_monthly${price}` }, period: { start, end }, proration: false }] },
  }
  stripe.invoices.set(invoice.id, invoice)
  paid.invoice = invoice.id
  const subscription = {
    id: "sub_buyer",
    customer: "cus_buyer",
    status: "active",
    cancel_at_period_end: false,
    metadata: { vector_account_id: user.id, vector_model_credits_usd: String(price / 2) },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
          price: {
            id: `price_monthly${price}`,
            currency: "usd",
            unit_amount: price * 100,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: invoice.id,
  }
  stripe.subscriptions = [subscription]
  return { subscription, invoice, charge: paid, start, end }
}

/** A completed top-up checkout, paid in full. */
async function topUp(price = 10) {
  await modelTopupCheckout(user, `codium-topup-${price}`, fetcher)
  const session = [...stripe.sessions.values()].at(-1)!
  const paid = charge({ amount: price * 100 })
  const payment = {
    id: `pi_buyer${sequence}`,
    customer: "cus_buyer",
    currency: "usd",
    status: "succeeded",
    amount: price * 100,
    amount_received: price * 100,
    metadata: session.metadata,
    latest_charge: paid.id,
  }
  stripe.payments.set(payment.id, payment)
  paid.payment_intent = payment.id
  Object.assign(session, { status: "complete", payment_status: "paid", payment_intent: payment.id })
  return { session, payment, charge: paid }
}

const event = (type: string, object: Record<string, unknown>, id = `evt_${type}_${sequence}`) => ({
  id,
  type,
  data: { object },
})
const activeKeys = () => [...openRouter.keys.values()].map((value) => value.data).filter((value) => !value.disabled)

describe("payment notifications grant and remove credits without anyone acting", () => {
  test("a subscription checkout grants the month's credits before the first request, once", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const paid = subscribe(50)
    const completed = event("checkout.session.completed", {
      id: "cs_subscription",
      customer: "cus_buyer",
      mode: "subscription",
      status: "complete",
    })
    await reconcileModelPlanEvent(completed, fetcher)
    expect(openRouter.keys.size).toBe(1)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({
      limit: 25,
      disabled: false,
      limit_reset: null,
      expires_at: new Date(paid.end * 1000).toISOString(),
    })
    // Stripe retries and the dashboard's resend deliver the same notification again; nothing changes.
    await reconcileModelPlanEvent(completed, fetcher)
    await reconcileModelPlanEvent(event("invoice.paid", paid.invoice), fetcher)
    expect(openRouter.keys.size).toBe(1)
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe("codium-secret-1")
  })

  test("each renewal resets the month's credits on a fresh key and retires the old one", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const first = subscribe(10)
    await reconcileModelPlanEvent(event("invoice.paid", first.invoice), fetcher)
    openRouter.keys.get("codium_key_1")!.data.usage = 4.5
    // Stripe moves the subscription to its next period and pays that period's invoice.
    const renewal = subscribe(10, first.end)
    await reconcileModelPlanAccount(user.id, fetcher, (first.end + 60) * 1000)
    expect(openRouter.keys.get("codium_key_1")?.data.disabled).toBe(true)
    expect(openRouter.keys.get("codium_key_2")?.data).toMatchObject({
      limit: 5,
      usage: 0,
      disabled: false,
      expires_at: new Date(renewal.end * 1000).toISOString(),
    })
  })

  test("a failed renewal, a cancellation and a refund each switch the month's credits off", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const paid = subscribe(10)
    await reconcileModelPlanEvent(event("invoice.paid", paid.invoice), fetcher)
    expect(activeKeys()).toHaveLength(1)

    // Failed renewal: Stripe marks the subscription past due and its latest invoice open.
    Object.assign(paid.subscription, { status: "past_due" })
    Object.assign(paid.invoice, { paid: false, status: "open" })
    await reconcileModelPlanEvent(event("invoice.payment_failed", paid.invoice), fetcher)
    expect(activeKeys()).toHaveLength(0)
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })

    // The retry succeeds: the same period's credits come back on the same key, usage kept.
    openRouter.keys.get("codium_key_1")!.data.usage = 1
    Object.assign(paid.subscription, { status: "active" })
    Object.assign(paid.invoice, { paid: true, status: "paid" })
    await reconcileModelPlanEvent(event("invoice.paid", paid.invoice), fetcher)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ disabled: false, usage: 1, limit: 5 })

    // A refund of the period's charge takes the month's credits away.
    Object.assign(paid.charge, { amount_refunded: 1000, refunded: true })
    await reconcileModelPlanEvent(event("charge.refunded", { ...paid.charge }), fetcher)
    expect(activeKeys()).toHaveLength(0)

    // Cancellation.
    Object.assign(paid.charge, { amount_refunded: 0, refunded: false })
    await reconcileModelPlanEvent(event("invoice.paid", paid.invoice), fetcher)
    expect(activeKeys()).toHaveLength(1)
    Object.assign(paid.subscription, { status: "canceled" })
    await reconcileModelPlanEvent(event("customer.subscription.deleted", paid.subscription), fetcher)
    expect(activeKeys()).toHaveLength(0)
  })

  test("a top-up grants its credits at once and later top-ups add to them", async () => {
    const first = await topUp(10)
    await reconcileModelPlanEvent(event("checkout.session.completed", first.session), fetcher)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 5, expires_at: null, disabled: false })
    openRouter.keys.get("codium_key_1")!.data.usage = 2
    const second = await topUp(50)
    await reconcileModelPlanEvent(event("checkout.session.completed", second.session), fetcher)
    await reconcileModelPlanEvent(event("checkout.session.completed", second.session), fetcher)
    expect(openRouter.keys.size).toBe(1)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 30, usage: 2, disabled: false })
    expect((await readModelPlanAccount(user.id, fetcher))?.purchases).toHaveLength(2)

    // A dispute on the first top-up takes its credits away until Stripe says the dispute was won.
    first.charge.disputed = true
    stripe.disputes = [
      { charge: first.charge.id, payment_intent: first.payment.id, status: "needs_response", balance_transactions: [] },
    ]
    await reconcileModelPlanEvent(event("charge.dispute.created", { charge: first.charge.id }), fetcher)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 25 })
    stripe.disputes = [
      { charge: first.charge.id, payment_intent: first.payment.id, status: "won", balance_transactions: [] },
    ]
    await reconcileModelPlanEvent(event("charge.dispute.closed", { charge: first.charge.id }), fetcher)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 30 })
  })

  test("simultaneous notifications for one payment all succeed and grant once", async () => {
    const bought = await topUp(10)
    const completed = event("checkout.session.completed", bought.session)
    // Stripe delivers several notifications about one payment at the same moment; each waits its turn for the lease.
    const results = await Promise.allSettled(
      [
        completed,
        completed,
        event("payment_intent.succeeded", { ...bought.payment }),
        event("charge.succeeded", { ...bought.charge }),
        event("charge.updated", { ...bought.charge }),
      ].map((value) => reconcileModelPlanEvent(value, fetcher)),
    )
    expect(results.filter((result) => result.status === "rejected")).toEqual([])
    expect(openRouter.keys.size).toBe(1)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 5, disabled: false })
  })

  test("a buyer's first request waits for a notification that is still granting the credits", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    subscribe(10)
    // A notification holds the account's lease for a moment, as it does while it creates the month's key.
    const lease = `vector:billing-mutation:${createHash("sha256").update(`model-plan:${user.id}`).digest("hex")}`
    await redis(["SET", lease, "webhook", "PX", "600"])
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe("codium-secret-1")
  })

  test("only a correctly signed notification is accepted", () => {
    const raw = Buffer.from(JSON.stringify(event("invoice.paid", { customer: "cus_buyer" })))
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = createHmac("sha256", "whsec_fixture").update(`${timestamp}.`).update(raw).digest("hex")
    expect(verifyModelPlanWebhook(raw, `t=${timestamp},v1=${signature}`)).toMatchObject({ type: "invoice.paid" })
    expect(() => verifyModelPlanWebhook(raw, `t=${timestamp},v1=${"0".repeat(64)}`)).toThrow()
    expect(() => verifyModelPlanWebhook(raw, `t=${timestamp - 600},v1=${signature}`)).toThrow()
  })
})

describe("sales follow Vector's OpenRouter balance", () => {
  const funded = (dollars: number, used = 0) => (openRouter.credits = { total_credits: dollars, total_usage: used })
  const other = (name: string, data: Record<string, unknown>) =>
    openRouter.keys.set(name, { key: name, data: { name, hash: name, usage: 0, disabled: false, ...data } })

  test("pauses new sales when the balance cannot cover what is owed, tells the owner, and reopens when funded", async () => {
    funded(300)
    // Keys that are not Codium's, switched off, or expired are not owed.
    other("owner-laptop", { name: "Owner laptop", limit: 1000 })
    other("expired", { name: `Vector ${user.id} sub_old 1`, limit: 500, expires_at: "2026-01-01T00:00:00.000Z" })
    other("disabled", { name: `Codium ${user.id} purchased credits`, limit: 500, disabled: true })
    // Nothing is owed yet, but the balance must leave room for the largest purchase ($100 of fixture credits).
    expect(await checkCodiumFunding(fetcher)).toMatchObject({
      status: "open",
      owed: 0,
      reserved: 0,
      required: 13000,
      notified: false,
    })
    expect(emails).toHaveLength(0)

    const bought = await topUp(200)
    await reconcileModelPlanEvent(event("checkout.session.completed", bought.session), fetcher)
    openRouter.keys.get("codium_key_4")!.data.usage = 0.004
    // Owed $99.996 rounds up to $100.00. Its checkout's reservation still counts too, as does room for the largest
    // purchase: ($100 + $100 + $100) with the default 10% and $20 margin is $350, and $300 is there.
    expect(await checkCodiumFunding(fetcher)).toMatchObject({
      status: "paused",
      reason: "short",
      balance: 30000,
      owed: 10000,
      reserved: 10000,
      required: 35000,
      keys: 1,
      notified: true,
    })
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({
      to: "owner@example.test",
      from: "Vector <support@example.test>",
      subject: "Vector Codium sales paused: OpenRouter is short $50.00",
    })
    expect(String(emails[0]!.text)).toContain("Credits customers already bought keep working.")

    const paused = { code: "CODIUM_SALES_PAUSED", statusCode: 503 }
    await expect(modelTopupCheckout(user, "codium-topup-10", fetcher)).rejects.toMatchObject(paused)
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject(paused)
    expect(stripe.sessions.size).toBe(1)
    // Credits already bought keep working while sales are paused.
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe("codium-secret-4")

    // Later checks while paused stay quiet, then remind the owner once a day. By then the checkout's reservation has
    // lapsed: ($100 + $100) with the margin is $240.
    await checkCodiumFunding(fetcher)
    expect(emails).toHaveLength(1)
    funded(200)
    expect(await checkCodiumFunding(fetcher, Date.now() + 25 * 60 * 60_000)).toMatchObject({
      status: "paused",
      reserved: 0,
      required: 24000,
      notified: true,
    })
    expect(emails).toHaveLength(2)

    // OpenRouter's auto top-up (or the owner) adds credits: sales reopen at the next check by themselves.
    funded(220, 100)
    expect(await checkCodiumFunding(fetcher, Date.now() + 26 * 60 * 60_000)).toMatchObject({
      status: "paused",
      notified: false,
    })
    funded(400, 100)
    const now = Date.now() + 27 * 60 * 60_000
    expect(await checkCodiumFunding(fetcher, now)).toMatchObject({ status: "open", balance: 30000, notified: true })
    expect(emails.at(-1)).toMatchObject({ subject: "Vector Codium sales reopened" })
    expect((await modelTopupCheckout(user, "codium-topup-10", fetcher, now)).url).toStartWith(
      "https://checkout.stripe.com/",
    )
  })

  test("purchases made between checks cannot together sell more than the balance covers", async () => {
    funded(300)
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", required: 13000 })
    // Four buyers open $200 top-ups ($100 of credits each) at the same moment. With the 10% and $20 margin the $300
    // balance covers two: a third would need ($100 × 3) × 1.1 + $20 = $350.
    const buyers = ["1", "2", "3", "4"].map((digit) => ({
      id: user.id.replace(/^4/, digit),
      email: `${digit}@example.test`,
    }))
    const results = await Promise.allSettled(
      buyers.map((buyer) => modelTopupCheckout(buyer, "codium-topup-200", fetcher)),
    )
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2)
    expect(
      results.flatMap((result) => (result.status === "rejected" ? [(result.reason as { code: string }).code] : [])),
    ).toEqual(["CODIUM_SALES_PAUSED", "CODIUM_SALES_PAUSED"])
    expect(stripe.sessions.size).toBe(2)

    // The next check counts those checkouts, finds no room left for another large purchase, and tells the owner.
    expect(await checkCodiumFunding(fetcher)).toMatchObject({
      status: "paused",
      reserved: 20000,
      required: 35000,
      notified: true,
    })
    expect(emails).toHaveLength(1)
  })

  test("one buyer's paid top-ups keep their reservations, so buying again and again cannot oversell", async () => {
    funded(300)
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", required: 13000 })
    // The same buyer pays for $200 top-ups ($100 of credits each) one after another, before the next check counts any
    // of them as owed. The $300 balance covers two: a third would need ($100 × 3) × 1.1 + $20 = $350.
    const outcomes = await [1, 2, 3].reduce(
      async (previous) => [
        ...(await previous),
        await topUp(200).then(
          async (bought) => {
            await reconcileModelPlanEvent(event("checkout.session.completed", bought.session), fetcher)
            return "sold"
          },
          (error: { code: string }) => error.code,
        ),
      ],
      Promise.resolve<string[]>([]),
    )
    expect(outcomes).toEqual(["sold", "sold", "CODIUM_SALES_PAUSED"])
    expect(stripe.sessions.size).toBe(2)
    expect(activeKeys()).toEqual([expect.objectContaining({ limit: 200 })])
    // The next check counts both paid purchases as owed and, until their reservations lapse, as reserved too.
    expect(await checkCodiumFunding(fetcher)).toMatchObject({
      status: "paused",
      owed: 20000,
      reserved: 20000,
      required: 57000,
    })
  })

  test("a buyer's new checkout gives back the reservation of the one it closes, and a reservation lapses after its checkout closes", async () => {
    funded(300)
    await checkCodiumFunding(fetcher)
    // Switching packs again and again closes each earlier checkout and holds only the latest one.
    await modelTopupCheckout(user, "codium-topup-200", fetcher)
    await modelTopupCheckout(user, "codium-topup-100", fetcher)
    await modelTopupCheckout(user, "codium-topup-200", fetcher)
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", reserved: 10000, required: 24000 })
    // A checkout Stripe has already closed gives its reservation back too.
    stripe.sessions.get("cs_buyer3")!.status = "expired"
    await modelTopupCheckout(user, "codium-topup-100", fetcher)
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", reserved: 5000, required: 18500 })
    // Two hours on, every checkout opened now has closed and its reservation has lapsed.
    expect(await checkCodiumFunding(fetcher, Date.now() + 2 * 60 * 60_000)).toMatchObject({ reserved: 0 })
  })

  test("a sale without a recent check runs one, and sales stay closed while OpenRouter cannot be read", async () => {
    funded(300)
    openRouter.unavailable = true
    await expect(modelTopupCheckout(user, "codium-topup-10", fetcher)).rejects.toMatchObject({
      code: "CODIUM_SALES_PAUSED",
    })
    expect(stripe.sessions.size).toBe(0)
    expect(await readCodiumFunding(fetcher)).toMatchObject({
      status: "paused",
      reason: "unavailable",
      error: "CODIUM_FUNDING_UNAVAILABLE",
      balance: null,
    })

    openRouter.unavailable = false
    await checkCodiumFunding(fetcher)
    await modelTopupCheckout(user, "codium-topup-10", fetcher)
    const checked = await readCodiumFunding(fetcher)
    expect(checked).toMatchObject({ status: "open", balance: 30000 })

    // A stale reading is checked again before the next sale; a failed check closes sales and is saved as a pause.
    openRouter.unavailable = true
    const later = Date.now() + CODIUM_FUNDING_MAX_AGE_MS + 1000
    await expect(modelTopupCheckout(user, "codium-topup-50", fetcher, later)).rejects.toMatchObject({
      code: "CODIUM_SALES_PAUSED",
    })
    expect(await readCodiumFunding(fetcher)).toMatchObject({
      status: "paused",
      reason: "unavailable",
      checkedAt: later,
    })
    expect(stripe.sessions.size).toBe(1)
  })

  test("a scheduled check that cannot read OpenRouter pauses sales at once, not when the last reading ages out", async () => {
    funded(1000)
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", ran: true })

    // A minute later OpenRouter stops answering. The scheduled check fails (its route answers 503), and that failure
    // pauses sales straight away instead of leaving the last good reading in force.
    openRouter.unavailable = true
    const minute = Date.now() + 60_000
    await expect(checkCodiumFunding(fetcher, minute)).rejects.toMatchObject({ code: "CODIUM_FUNDING_UNAVAILABLE" })
    await expect(modelTopupCheckout(user, "codium-topup-10", fetcher, minute)).rejects.toMatchObject({
      code: "CODIUM_SALES_PAUSED",
    })
    await expect(modelPlanCheckout(user, "vector-10", fetcher, minute)).rejects.toMatchObject({
      code: "CODIUM_SALES_PAUSED",
    })
    expect(stripe.sessions.size).toBe(0)
    expect(emails).toHaveLength(1)
    expect(emails[0]).toMatchObject({ subject: "Vector Codium sales paused: the funding check could not finish" })
    expect(String(emails[0]!.text)).toContain("Vector's OpenRouter balance could not be read.")
    // Later failures while paused stay quiet.
    await expect(checkCodiumFunding(fetcher, minute + 600_000)).rejects.toMatchObject({
      code: "CODIUM_FUNDING_UNAVAILABLE",
    })
    expect(emails).toHaveLength(1)

    // OpenRouter answers again: the next check reopens sales and says so.
    openRouter.unavailable = false
    const reopened = minute + 1_200_000
    expect(await checkCodiumFunding(fetcher, reopened)).toMatchObject({ status: "open", notified: true })
    expect(emails.at(-1)).toMatchObject({ subject: "Vector Codium sales reopened" })
    expect((await modelTopupCheckout(user, "codium-topup-10", fetcher, reopened)).url).toStartWith(
      "https://checkout.stripe.com/",
    )
  })

  test("a key listing that repeats a page instead of moving on keeps sales closed", async () => {
    other("first", { name: "Owner laptop", limit: 1 })
    other("second", { name: "Owner desktop", limit: 1 })
    openRouter.ignoreOffset = true
    await expect(checkCodiumFunding(fetcher)).rejects.toMatchObject({ code: "CODIUM_FUNDING_UNAVAILABLE" })
    await expect(modelTopupCheckout(user, "codium-topup-10", fetcher)).rejects.toMatchObject({
      code: "CODIUM_SALES_PAUSED",
    })
    openRouter.ignoreOffset = false
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "open", keys: 0 })
  })

  test("an email that fails to send is retried at the next check", async () => {
    funded(10)
    process.env.CODIUM_FUNDING_MARGIN_USD = "50"
    resend.failing = true
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "paused", required: 16000, notified: false })
    expect(await readCodiumFunding(fetcher)).not.toHaveProperty("notifiedAt")
    resend.failing = false
    expect(await checkCodiumFunding(fetcher)).toMatchObject({ status: "paused", notified: true })
    expect(emails).toHaveLength(1)
    process.env.CODIUM_FUNDING_MARGIN_PERCENT = "-5"
    await expect(checkCodiumFunding(fetcher)).rejects.toMatchObject({ code: "CODIUM_FUNDING_CONFIGURATION" })
  })

  test("the scheduled check needs the cron secret and does nothing while Codium is off", async () => {
    const { default: handler } = await import("../../../api/model-plans/funding")
    const route = createServer((request, response) => void handler(request, response))
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve))
    const address = route.address()
    if (!address || typeof address === "string") throw new Error("Missing route address")
    const call = (authorization?: string) =>
      fetch(`http://127.0.0.1:${address.port}/api/model-plans/funding`, {
        headers: authorization ? { authorization } : {},
      })
    expect((await call()).status).toBe(401)
    expect((await call("Bearer wrong")).status).toBe(401)
    process.env.MODEL_PLANS_ENABLED = "false"
    const response = await call("Bearer cron-fixture-secret")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false })
    route.close()
  })
})

describe("the private profit ledger", () => {
  async function owner(authorization?: string, path = "/api/model-plans/ledger", method = "GET") {
    const route = createServer((request, response) => void handleCodiumLedger(request, response, fetcher))
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve))
    const address = route.address()
    if (!address || typeof address === "string") throw new Error("Missing route address")
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: authorization ? { authorization } : {},
    })
    route.close()
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const entry = async (charge: string) => (await codiumLedger(fetcher)).find((value) => value.charge === charge)

  test("records each payment's price, Stripe fee, credits, OpenRouter fee and profit, once", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const monthly = subscribe(50)
    await reconcileModelPlanEvent(event("invoice.paid", monthly.invoice), fetcher)
    await reconcileModelPlanEvent(event("invoice.paid", monthly.invoice), fetcher)
    // $50 paid, Stripe's fixture fee 2.9% + 30c, $25 of model credit, OpenRouter's 5.5% on buying it.
    expect(await entry(monthly.charge.id)).toMatchObject({
      kind: "subscription",
      account: user.id,
      product: "vector-50",
      price: 5000,
      refunded: 0,
      disputed: false,
      stripeFee: 175,
      stripeNet: 4825,
      credits: 2500,
      openRouterFee: 138,
      profit: 2187,
    })
    const bought = await topUp(10)
    await reconcileModelPlanEvent(event("charge.succeeded", { ...bought.charge }), fetcher)
    await reconcileModelPlanEvent(event("checkout.session.completed", bought.session), fetcher)
    expect(await entry(bought.charge.id)).toMatchObject({
      kind: "topup",
      product: "codium-topup-10",
      price: 1000,
      stripeFee: 59,
      stripeNet: 941,
      credits: 500,
      openRouterFee: 28,
      profit: 413,
    })
    expect(await codiumLedger(fetcher)).toHaveLength(2)

    // Half the top-up refunded: half its credits and the refunded money leave the books.
    Object.assign(bought.charge, { amount_refunded: 500 })
    await reconcileModelPlanEvent(event("charge.refunded", { ...bought.charge }), fetcher)
    expect(await entry(bought.charge.id)).toMatchObject({
      refunded: 500,
      stripeNet: 441,
      credits: 250,
      openRouterFee: 14,
      profit: 177,
    })
    expect(openRouter.keys.get("codium_key_2")?.data.limit).toBe(2.5)
    // A refund's own updates name its charge and rewrite the same entry.
    await reconcileModelPlanEvent(event("charge.refund.updated", { id: "re_buyer", charge: bought.charge.id }), fetcher)
    expect(await codiumLedger(fetcher)).toHaveLength(2)
    expect(await entry(bought.charge.id)).toMatchObject({ refunded: 500, profit: 177 })
  })

  test("a slow notification that read the charge before a refund cannot undo the refund's entry", async () => {
    const bought = await topUp(10)
    await reconcileModelPlanEvent(event("checkout.session.completed", bought.session), fetcher)
    // Notification A reads the charge before the refund, then stalls before it writes.
    let resume = () => {}
    const stalled = new Promise<void>((resolve) => (resume = resolve))
    const slow: typeof fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetcher(input, init)
        if (!new URL(input instanceof Request ? input.url : input).pathname.startsWith("/v1/charges/")) return response
        const body = await response.text()
        await stalled
        return new Response(body, { status: response.status, headers: response.headers })
      },
      { preconnect: fetch.preconnect },
    )
    const first = recordCodiumCharge(user.id, bought.charge.id, slow)
    await Bun.sleep(50)
    // The refund lands and its own notification B arrives while A is still stalled.
    Object.assign(bought.charge, { amount_refunded: 1000, refunded: true })
    const second = recordCodiumCharge(user.id, bought.charge.id, fetcher)
    setTimeout(resume, 300)
    await Promise.all([first, second])
    expect(await entry(bought.charge.id)).toMatchObject({ refunded: 1000, credits: 0 })
  })

  test("a top-up spent before a lost dispute or a refund still costs what was spent", async () => {
    const first = await topUp(10)
    await reconcileModelPlanEvent(event("checkout.session.completed", first.session), fetcher)
    // The buyer spends $4.90 of the top-up's $5 of fixture credits, then disputes the charge and wins nothing back.
    openRouter.keys.get("codium_key_1")!.data.usage = 4.9
    first.charge.disputed = true
    stripe.disputes = [
      {
        charge: first.charge.id,
        payment_intent: first.payment.id,
        status: "lost",
        balance_transactions: [{ amount: -1000, fee: 1500, net: -2500 }],
      },
    ]
    await reconcileModelPlanEvent(event("charge.dispute.closed", { charge: first.charge.id }), fetcher)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 0, disabled: true })
    // Stripe's net is the $9.41 kept less the $25 withdrawal; the $4.90 spent and OpenRouter's 5.5% on it are Vector's.
    expect(await entry(first.charge.id)).toMatchObject({
      disputed: true,
      granted: 500,
      credits: 490,
      reversedSpend: 490,
      openRouterFee: 27,
      profit: 941 - 2500 - 490 - 27,
    })

    // A second top-up first pays for that spend: the buyer can use $20.10 of its $25, and nothing is lost.
    const second = await topUp(50)
    await reconcileModelPlanEvent(event("checkout.session.completed", second.session), fetcher)
    await reconcileModelPlanEvent(event("charge.succeeded", { ...second.charge }), fetcher)
    expect(await entry(first.charge.id)).toMatchObject({ credits: 0, reversedSpend: 0 })
    expect((await codiumLedgerSummary(fetcher)).totals).toMatchObject({ credits: 2500, reversedSpend: 0 })

    // Spent to its limit and then half refunded, it costs everything spent, not the $12.50 still paid for. The spend
    // above what is still paid for goes to the reversed top-ups oldest first.
    openRouter.keys.get("codium_key_1")!.data.usage = 25
    Object.assign(second.charge, { amount_refunded: 2500 })
    await reconcileModelPlanEvent(event("charge.refunded", { ...second.charge }), fetcher)
    expect(openRouter.keys.get("codium_key_1")?.data).toMatchObject({ limit: 12.5, disabled: true })
    expect(await entry(first.charge.id)).toMatchObject({ credits: 500, reversedSpend: 500 })
    expect(await entry(second.charge.id)).toMatchObject({ granted: 2500, credits: 2000, reversedSpend: 750 })
    expect((await codiumLedgerSummary(fetcher)).totals).toMatchObject({ credits: 2500, reversedSpend: 1250 })

    // A third top-up pays for that spend in turn, so the reversals cost nothing beyond what is paid for.
    const third = await topUp(200)
    await reconcileModelPlanEvent(event("checkout.session.completed", third.session), fetcher)
    await reconcileModelPlanEvent(event("charge.succeeded", { ...third.charge }), fetcher)
    expect((await codiumLedgerSummary(fetcher)).totals).toMatchObject({ credits: 1250 + 10000, reversedSpend: 0 })
  })

  test("a disputed month costs what was spent before it, plus Stripe's dispute fee, until the dispute is won", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const monthly = subscribe(50)
    await reconcileModelPlanEvent(event("invoice.paid", monthly.invoice), fetcher)
    openRouter.keys.get("codium_key_1")!.data.usage = 3.2
    monthly.charge.disputed = true
    const withdrawal = { amount: -5000, fee: 1500, net: -6500 }
    stripe.disputes = [{ charge: monthly.charge.id, status: "needs_response", balance_transactions: [withdrawal] }]
    await reconcileModelPlanEvent(event("charge.dispute.created", { charge: monthly.charge.id }), fetcher)
    expect(activeKeys()).toHaveLength(0)
    expect(await entry(monthly.charge.id)).toMatchObject({
      disputed: true,
      stripeFee: 1675,
      stripeNet: -1675,
      credits: 320,
      openRouterFee: 18,
      profit: -2013,
    })
    stripe.disputes = [
      {
        charge: monthly.charge.id,
        status: "won",
        balance_transactions: [withdrawal, { amount: 5000, fee: 0, net: 5000 }],
      },
    ]
    await reconcileModelPlanEvent(event("charge.dispute.closed", { charge: monthly.charge.id }), fetcher)
    expect(activeKeys()).toHaveLength(1)
    expect(await entry(monthly.charge.id)).toMatchObject({
      disputed: false,
      stripeFee: 1675,
      stripeNet: 3325,
      credits: 2500,
      profit: 687,
    })
  })

  test("leaves out other charges and marks a fee Stripe has not settled yet", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const unrelated = charge({ amount: 4200 })
    await reconcileModelPlanEvent(event("charge.succeeded", { ...unrelated }), fetcher)
    const failed = subscribe(10)
    Object.assign(failed.charge, { paid: false })
    await reconcileModelPlanEvent(event("charge.failed", { ...failed.charge }), fetcher)
    expect(await codiumLedger(fetcher)).toEqual([])

    const pending = subscribe(10)
    pending.charge.balance_transaction = null
    await reconcileModelPlanEvent(event("invoice.paid", pending.invoice), fetcher)
    expect(await entry(pending.charge.id)).toMatchObject({ stripeFee: null, stripeNet: 1000, credits: 500 })
    expect((await codiumLedgerSummary(fetcher)).totals).toMatchObject({ payments: 1, feesPending: 1 })
  })

  test("converts Stripe's fees back to dollars for an account that settles in another currency", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const monthly = subscribe(10)
    monthly.charge.balance_transaction = {
      id: "txn_inr",
      amount: 83500,
      fee: 4900,
      net: 78600,
      currency: "inr",
      exchange_rate: 83.5,
    }
    await reconcileModelPlanEvent(event("invoice.paid", monthly.invoice), fetcher)
    expect(await entry(monthly.charge.id)).toMatchObject({ price: 1000, stripeFee: 59, stripeNet: 941 })
  })

  test("only the owner's secret reads the summary; everyone else sees nothing there", async () => {
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_buyer" })])
    const monthly = subscribe(10)
    await reconcileModelPlanEvent(event("invoice.paid", monthly.invoice), fetcher)
    await checkCodiumFunding(fetcher)
    const secret = String(process.env.CODIUM_OWNER_SECRET)
    expect(await owner()).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } })
    expect((await owner(`Bearer ${secret}x`)).status).toBe(404)
    expect((await owner(undefined, "/api/model-plans/ledger", "POST")).status).toBe(404)
    expect((await owner(`Bearer ${secret}`, "/api/model-plans/ledger", "POST")).status).toBe(405)
    expect((await owner(`Bearer ${await mintAccountToken()}`)).status).toBe(404)

    const summary = await owner(`Bearer ${secret}`)
    expect(summary.status).toBe(200)
    expect(summary.body).toMatchObject({
      currency: "usd",
      unit: "cents",
      totals: { payments: 1, price: 1000, stripeFee: 59, credits: 500, openRouterFee: 28, profit: 413 },
      months: [{ month: "2026-10", payments: 1, profit: 413 }],
      funding: { status: "open", owed: 500 },
    })
    expect(summary.body).not.toHaveProperty("entries")
    expect((await owner(`Bearer ${secret}`, "/api/model-plans/ledger?entries=1")).body.entries).toHaveLength(1)

    // A short secret is treated as unset.
    process.env.CODIUM_OWNER_SECRET = "short"
    expect((await owner("Bearer short")).status).toBe(404)
  })
})

async function mintAccountToken() {
  process.env.VECTOR_CLI_TOKEN_SECRET = "fixture-token-secret".repeat(3)
  const { mintCliToken } = await import("../../../api/_lib/cli-token")
  return mintCliToken(user).token
}
