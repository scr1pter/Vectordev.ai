import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createHash } from "node:crypto"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mintCliToken } from "../../../api/_lib/cli-token"
import {
  cancelModelPlanAccount,
  keyExpiresAt,
  modelPlanCheckout,
  modelPlanCredential,
  modelPlanPortal,
  modelPlanStatus,
  paidModelPlan,
  readModelPlanAccount,
} from "../../../api/_lib/model-plan-account"
import {
  handleModelPlanChange,
  handleModelPlanCheckout,
  handleModelPlanPortal,
  handleModelTopupRemoved,
} from "../../../api/_lib/model-plan-billing"
import { handleModelPlanChat } from "../../../api/_lib/model-plan-chat"
import { handleModelPlanModels } from "../../../api/_lib/model-plan-models"
import { handleModelPlanStatus, modelPlanBalance } from "../../../api/_lib/model-plan-status"
import { ModelPlans } from "@vectordevai/core/model-plans"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"

// External HTTP boundaries are local fixtures; leases and rate-limit Lua run
// against a real, isolated Redis/Valkey database, just as in free-models-api.
const temporary = await mkdtemp(join(tmpdir(), "vector-model-plans-"))
const socket = join(temporary, "db.sock")
const database = process.env.VECTOR_TEST_REDIS_URL ? new RedisClient(process.env.VECTOR_TEST_REDIS_URL) : undefined
const processHandle = database
  ? undefined
  : Bun.spawn(
      [
        process.env.VECTOR_TEST_VALKEY_SERVER ?? "valkey-server",
        "--port",
        "0",
        "--unixsocket",
        socket,
        "--unixsocketperm",
        "700",
        "--save",
        "",
        "--appendonly",
        "no",
        "--dir",
        temporary,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )

async function redis(command: readonly (string | number)[]): Promise<unknown> {
  if (database) return database.send(String(command[0]), command.slice(1).map(String))
  const child = Bun.spawn(
    [process.env.VECTOR_TEST_VALKEY_CLI ?? "valkey-cli", "-s", socket, "--json", ...command.map(String)],
    { stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(child.stdout).text()
  if (await child.exited) throw new Error(`Fixture Redis command failed: ${await new Response(child.stderr).text()}`)
  return JSON.parse(output)
}

const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
// Stripe test mode keeps every Codium key in the test namespace.
const accountKey = `vector:codium:test:account:${user.id}`
const heldKey = "vector:codium:test:held:hash_fixture1"
const model = {
  id: "fixture/paid-model",
  name: "Fixture model",
  contextLength: 8192,
  maxOutputTokens: 2048,
  inputPrice: 1,
  outputPrice: 2,
}
const environment = [
  "NODE_ENV",
  "VERCEL_ENV",
  "CODIUM_STRIPE_MODE",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "CODIUM_3DS_MIN_USD",
  "VECTOR_ADMIN_EMAILS",
  "MODEL_PLANS_MIN_CLIENT",
  "MODEL_PLANS_ENABLED",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  "STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID",
  "STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "OPENROUTER_MANAGEMENT_KEY",
  "VECTOR_CLI_TOKEN_SECRET",
  "VECTOR_ABUSE_SECRET",
  "VECTOR_PUBLIC_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  ...[10, 50, 100, 200].flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]
const previousEnvironment = new Map(environment.map((key) => [key, process.env[key]]))

function subscription(start = Math.floor(Date.now() / 1000) - 3600, end = start + 7200) {
  return {
    id: "sub_fixture",
    status: "active",
    cancel_at_period_end: false,
    metadata: { vector_account_id: user.id },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
          price: {
            id: "price_fixture10",
            active: true,
            currency: "usd",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_fixture",
      paid: true,
      status: "paid",
      amount_paid: 1000,
      charge: { paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      lines: { data: [{ price: { id: "price_fixture10" }, period: { start, end }, proration: false }] },
    },
  }
}

const state = {
  origin: "",
  unavailable: false,
  loseCheckoutResponse: false,
  failClosingWrite: false,
  failCheckoutExpiry: false,
  failSubscriptionCancellation: false,
  checkoutListMode: "normal",
  priceMismatch: false,
  upstreamStatus: 200,
  streamMode: "normal",
  charge: 0,
  keyReadDelay: 0,
  chatDelay: 0,
  subscriptions: [] as (ReturnType<typeof subscription> & { schedule?: string })[],
}
const calls: { path: string; method: string; headers: Headers; body: Record<string, unknown> }[] = []
const commands: (string | number)[][] = []
const sessions = new Map<
  string,
  { id: string; customer: string; url: string; expires_at: number; status: string; metadata: Record<string, unknown> }
>()
const idempotency = new Map<string, Record<string, unknown>>()
const keys = new Map<string, { secret: string; data: Record<string, unknown> }>()
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/redis") {
      if (state.unavailable) return new Response(null, { status: 503 })
      expect(request.headers.get("authorization")).toBe("Bearer fixture-kv-token")
      const command: unknown = await request.json()
      if (!Array.isArray(command) || command.some((part) => typeof part !== "string" && typeof part !== "number"))
        throw new Error("Invalid Redis command")
      commands.push(command)
      if (
        state.failClosingWrite &&
        command[0] === "SET" &&
        command[1] === accountKey &&
        String(command[2]).includes('"closing":true')
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
    calls.push({ path: url.pathname, method: request.method, headers: new Headers(request.headers), body })
    // The website's browser session, as Supabase answers for it.
    if (url.pathname === "/auth/v1/user") {
      if (request.headers.get("authorization") !== "Bearer browser-session") return new Response(null, { status: 401 })
      return Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z" })
    }
    if (url.pathname.startsWith("/v1/")) {
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_fixture")
      if (url.pathname === "/v1/customers") return Response.json({ id: "cus_fixture" })
      if (url.pathname === "/v1/subscriptions") return Response.json({ data: state.subscriptions, has_more: false })
      if (url.pathname.startsWith("/v1/subscriptions/") && request.method === "DELETE") {
        if (state.failSubscriptionCancellation) return new Response(null, { status: 503 })
        const subscription = state.subscriptions.find((item) => item.id === url.pathname.split("/").at(-1))
        if (!subscription) return Response.json({ error: "Unknown subscription" }, { status: 404 })
        subscription.status = "canceled"
        return Response.json(subscription)
      }
      if (url.pathname.startsWith("/v1/prices/")) {
        const amount = Number(url.pathname.match(/(\d+)$/)?.[1])
        return Response.json({
          active: true,
          currency: "usd",
          unit_amount: (state.priceMismatch ? amount + 1 : amount) * 100,
          recurring: { interval: "month", interval_count: 1 },
        })
      }
      if (url.pathname === "/v1/invoices" && request.method === "GET")
        return Response.json({ data: [], has_more: false })
      if (url.pathname === "/v1/checkout/sessions") {
        if (request.method === "GET") {
          expect(url.searchParams.get("customer")).toBe("cus_fixture")
          expect(url.searchParams.get("status")).toBe("open")
          if (state.checkoutListMode === "invalid") return Response.json({ data: null, has_more: false })
          return Response.json({
            data: [...sessions.values()].filter(
              (session) => session.customer === url.searchParams.get("customer") && session.status === "open",
            ),
            has_more: state.checkoutListMode === "more",
          })
        }
        const token = request.headers.get("idempotency-key")
        if (!token) throw new Error("Checkout has no idempotency key")
        if (idempotency.has(token)) return Response.json(idempotency.get(token))
        const session = {
          id: `cs_fixture${sessions.size + 1}`,
          customer: String(body.customer),
          url: `https://checkout.stripe.com/c/pay/cs_fixture${sessions.size + 1}`,
          expires_at: Number(body.expires_at),
          status: "open",
          metadata: Object.fromEntries(
            Object.entries(body)
              .filter(([key]) => key.startsWith("metadata["))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
        }
        sessions.set(session.id, session)
        idempotency.set(token, session)
        if (state.loseCheckoutResponse) {
          state.loseCheckoutResponse = false
          return Response.json({ error: "fixture response lost" }, { status: 503 })
        }
        return Response.json(session)
      }
      if (url.pathname.startsWith("/v1/checkout/sessions/")) {
        const session = sessions.get(url.pathname.split("/")[4]!)
        if (!session) return Response.json({ error: "Unknown session" }, { status: 404 })
        if (url.pathname.endsWith("/expire")) {
          if (state.failCheckoutExpiry) return new Response(null, { status: 503 })
          session.status = "expired"
        }
        return Response.json(session)
      }
      if (url.pathname === "/v1/billing_portal/sessions")
        return Response.json({ url: "https://billing.stripe.com/p/session/fixture" })
    }
    if (url.pathname.startsWith("/api/v1/keys")) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-management-key")
      if (request.method === "POST") {
        const hash = `hash_fixture${keys.size + 1}`
        const key = {
          secret: `fixture-paid-secret-${keys.size + 1}`,
          data: { ...body, hash, disabled: false, usage: 0 },
        }
        keys.set(hash, key)
        return Response.json({ key: key.secret, data: key.data })
      }
      const key = keys.get(url.pathname.split("/").at(-1)!)
      if (!key) return Response.json({ error: "Unknown key" }, { status: 404 })
      if (request.method === "PATCH") Object.assign(key.data, body)
      if (request.method === "GET" && state.keyReadDelay) await Bun.sleep(state.keyReadDelay)
      return Response.json({ data: key.data })
    }
    if (url.pathname === "/api/v1/chat/completions") {
      expect(request.headers.get("authorization")).toBe(`Bearer ${keys.values().next().value?.secret}`)
      if (state.upstreamStatus !== 200)
        return Response.json({ error: { message: "PRIVATE fixture-paid-secret-1" } }, { status: state.upstreamStatus })
      // The provider bills a request, and the key's usage grows, only once it finishes.
      if (state.chatDelay) await Bun.sleep(state.chatDelay)
      const charged = keys.values().next().value
      if (charged && state.charge) charged.data.usage = Number(charged.data.usage ?? 0) + state.charge
      const mode = state.streamMode
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            // OpenRouter names the provider that served the request, as it does on every chunk.
            controller.enqueue(
              encoder.encode(
                'data: {"id":"gen-fixture","provider":"PRIVATE-PROVIDER","system_fingerprint":"fp_private","choices":[{"delta":{"content":"fixture"},"native_finish_reason":"PRIVATE-REASON"}]}\r',
              ),
            )
            controller.enqueue(encoder.encode("\n\r\n"))
            if (mode === "error")
              controller.enqueue(
                encoder.encode('data: {"error":{"code":402,"message":"PRIVATE fixture-paid-secret-1"}}\n\n'),
              )
            if (mode === "invalid") controller.enqueue(encoder.encode("data: not-json\n\n"))
            if (state.charge)
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ provider: "PRIVATE-PROVIDER", choices: [], usage: { prompt_tokens: 200, completion_tokens: 6, total_tokens: 206, cost: state.charge, is_byok: false, cost_details: { upstream_inference_cost: state.charge } } })}\n\n`,
                ),
              )
            if (mode !== "truncated") controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    throw new Error(`Unexpected fixture request: ${request.method} ${url.pathname}`)
  },
})
const fetcher: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin === "https://api.stripe.com" || url.origin === "https://openrouter.ai")
      return fetch(new URL(url.pathname + url.search, upstream.url), init)
    if (url.origin === upstream.url.origin) return fetch(input, init)
    throw new Error(`Unexpected network destination ${url.origin}`)
  },
  { preconnect: fetch.preconnect },
)
const server = createServer((request, response) => {
  // /chat is the gateway as the other tests call it; the /api/model-plans paths are what Vector itself requests.
  if (request.url === "/api/model-plans/models") return void handleModelPlanModels(request, response, fetcher)
  if (request.url === "/api/model-plans/status") return void handleModelPlanStatus(request, response, fetcher)
  if (request.url === "/api/model-plans/change") return void handleModelPlanChange(request, response, fetcher)
  if (request.url === "/api/model-plans/checkout") return void handleModelPlanCheckout(request, response, fetcher)
  if (request.url === "/api/model-plans/topup") return void handleModelTopupRemoved(request, response)
  if (request.url === "/api/model-plans/portal") return void handleModelPlanPortal(request, response, fetcher)
  void handleModelPlanChat(request, response, fetcher)
})

beforeAll(async () => {
  if (!database)
    for (let count = 0; count < 300 && !(await stat(socket).catch(() => undefined)); count++) await Bun.sleep(10)
  expect(await redis(["PING"])).toBe("PONG")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture server address")
  state.origin = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await redis(["FLUSHDB"])
  // Vector's OpenRouter balance covers what is owed; codium-payments.test.ts exercises the funding check itself.
  await redis([
    "SET",
    "vector:codium:test:funding",
    JSON.stringify({
      status: "open",
      checkedAt: Date.now(),
      since: Date.now(),
      balance: 100_000_000,
      owed: 0,
      required: 0,
      keys: 0,
    }),
  ])
  Object.assign(process.env, {
    NODE_ENV: "development",
    MODEL_PLANS_ENABLED: "true",
    MODEL_PLAN_MODELS_JSON: JSON.stringify([model]),
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "ab".repeat(32),
    STRIPE_SECRET_KEY: "sk_test_fixture",
    CODIUM_STRIPE_MODE: "test",
    // Test mode caps each key at CODIUM_TEST_CREDIT_CAP_USD; these tests use the fixture plans' full credits.
    CODIUM_TEST_CREDIT_CAP_USD: "200",
    // Test checkout is open only to admins.
    VECTOR_ADMIN_EMAILS: user.email,
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    VECTOR_CLI_TOKEN_SECRET: "fixture-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
    VECTOR_PUBLIC_URL: "https://vectordev.ai",
    KV_REST_API_URL: new URL("/redis", upstream.url).href,
    KV_REST_API_TOKEN: "fixture-kv-token",
    SUPABASE_URL: upstream.url.origin,
    SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
  })
  delete process.env.CODIUM_3DS_MIN_USD
  delete process.env.VERCEL_ENV
  delete process.env.MODEL_PLANS_MIN_CLIENT
  delete process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  // Fixture allowances that keep the public usage multiples (5.5x, 12x and 25x Plus), as Codium's configuration requires.
  for (const [price, credits] of [
    [10, "5"],
    [50, "27.5"],
    [100, "60"],
    [200, "125"],
  ] as const) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = credits
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_fixture${price}`
  }
  Object.assign(state, {
    unavailable: false,
    loseCheckoutResponse: false,
    failClosingWrite: false,
    failCheckoutExpiry: false,
    failSubscriptionCancellation: false,
    checkoutListMode: "normal",
    priceMismatch: false,
    upstreamStatus: 200,
    streamMode: "normal",
    charge: 0,
    keyReadDelay: 0,
    chatDelay: 0,
    subscriptions: [],
  })
  calls.length = 0
  commands.length = 0
  sessions.clear()
  idempotency.clear()
  keys.clear()
})
afterAll(async () => {
  server.closeAllConnections()
  server.close()
  upstream.stop(true)
  database?.close()
  if (processHandle) {
    processHandle.kill()
    await processHandle.exited
  }
  await rm(temporary, { recursive: true, force: true })
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
})

async function paid() {
  state.subscriptions = [subscription()]
  await redis(["SET", accountKey, JSON.stringify({ customer: "cus_fixture" })])
  return state.subscriptions[0]!
}
async function chat(
  body: unknown = { model: model.id, messages: [{ role: "user", content: "fixture prompt" }] },
  token = mintCliToken(user).token,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${state.origin}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  })
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
}
const mutations = () => calls.filter((call) => call.path.startsWith("/api/v1/keys") && call.method !== "GET")
const chats = () => calls.filter((call) => call.path === "/api/v1/chat/completions")

describe("subscription checkout with real billing leases", () => {
  test("HTTP checkout and Plus→Max upgrade forward the exact subscription 3DS field", async () => {
    expect(await billing("checkout", { plan: "vector-100" })).toMatchObject({ status: 200 })
    expect(
      calls.findLast((call) => call.path === "/v1/checkout/sessions" && call.method === "POST")!.body,
    ).toMatchObject({
      mode: "subscription",
      "payment_method_options[card][request_three_d_secure]": "any",
      "metadata[vector_3ds_requested]": "true",
    })

    // A paid Plus invoice is below Max's price and cannot exempt the upgrade.
    await paid()
    expect(await billing("change", { plan: "vector-100" })).toMatchObject({ status: 200 })
    expect(
      calls.findLast((call) => call.path === "/v1/checkout/sessions" && call.method === "POST")!.body,
    ).toMatchObject({
      mode: "subscription",
      "payment_method_options[card][request_three_d_secure]": "any",
      "subscription_data[metadata][vector_supersedes]": "sub_fixture",
    })
  })

  test("replaces a pending subscription checkout when its allowance or Stripe price changes", async () => {
    const first = await modelPlanCheckout(user, "vector-10", fetcher)
    process.env.MODEL_PLAN_10_CREDITS_USD = "7"
    const second = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(second.url).not.toBe(first.url)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(sessions.get("cs_fixture2")?.metadata.vector_model_credits_usd).toBe("7")
    process.env.STRIPE_MODEL_PLAN_10_PRICE_ID = "price_repriced10"
    const third = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(third.url).not.toBe(second.url)
    expect(sessions.get("cs_fixture2")?.status).toBe("expired")
    expect(sessions.get("cs_fixture3")?.metadata.vector_price_id).toBe("price_repriced10")
    expect(await modelPlanCheckout(user, "vector-10", fetcher)).toEqual(third)
  })

  test("reuses an open checkout, expires it when switching tiers, and returns a new session", async () => {
    const first = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(await modelPlanCheckout(user, "vector-10", fetcher)).toEqual(first)
    expect(sessions.size).toBe(1)
    const next = await modelPlanCheckout(user, "vector-50", fetcher)
    expect(next.url).not.toBe(first.url)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(sessions.size).toBe(2)
    const expire = calls.findIndex((call) => call.path.endsWith("/cs_fixture1/expire"))
    expect(calls.findLastIndex((call) => call.path === "/v1/checkout/sessions")).toBeGreaterThan(expire)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      customer: "cus_fixture",
      checkout: { id: "cs_fixture2", plan: "vector-50", url: next.url },
    })
    expect(calls.filter((call) => call.path === "/v1/customers")).toHaveLength(1)
    expect(calls.find((call) => call.path === "/v1/checkout/sessions")?.body["payment_method_types[0]"]).toBe("card")
    expect(commands.some((command) => command[0] === "EVAL" && String(command[1]).includes("PTTL"))).toBe(true)
    expect(await redis(["KEYS", "vector:codium:test:lease:*"])).toEqual([])
  })

  test("retries an ambiguous checkout response under the same Stripe idempotency key", async () => {
    state.loseCheckoutResponse = true
    const now = Date.now()
    await expect(modelPlanCheckout(user, "vector-10", fetcher, now)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    const result = await modelPlanCheckout(user, "vector-10", fetcher, now)
    const requests = calls.filter((call) => call.path === "/v1/checkout/sessions")
    expect(requests).toHaveLength(2)
    expect(requests[0]!.headers.get("idempotency-key")).toBe(requests[1]!.headers.get("idempotency-key"))
    expect(requests[0]!.body).toEqual(requests[1]!.body)
    expect(sessions.size).toBe(1)
    expect(result.url).toBe(sessions.get("cs_fixture1")!.url)
  })

  test("blocks duplicate subscriptions and mismatched prices before creating checkout", async () => {
    await paid()
    await expect(modelPlanCheckout(user, "vector-50", fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_EXISTS" })
    state.subscriptions = []
    state.priceMismatch = true
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_PRICE_MISMATCH",
    })
    expect(sessions.size).toBe(0)
  })

  test("does not create a second checkout while a completed session awaits subscription visibility", async () => {
    await modelPlanCheckout(user, "vector-10", fetcher)
    sessions.get("cs_fixture1")!.status = "complete"
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXISTS",
      statusCode: 409,
    })
    await expect(modelPlanCheckout(user, "vector-50", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXISTS",
      statusCode: 409,
    })
    expect(sessions.size).toBe(1)
    expect(calls.filter((call) => call.path === "/v1/checkout/sessions")).toHaveLength(1)
    expect(calls.some((call) => call.path.endsWith("/expire"))).toBe(false)
  })

  test("billing management remains reachable when new plan purchases are disabled", async () => {
    await paid()
    process.env.MODEL_PLANS_ENABLED = "false"
    expect(await modelPlanPortal(user.id, fetcher)).toEqual({ url: "https://billing.stripe.com/p/session/fixture" })
    expect(calls.at(-1)?.body).toMatchObject({
      customer: "cus_fixture",
      configuration: "bpc_fixture",
      return_url: "https://vectordev.ai/account",
    })
  })
})

// What the desktop app's main process sends: the Vector account token from its own sign-in and a JSON body, with no
// Origin header.
async function billing(
  path: "checkout" | "topup" | "portal" | "change",
  body: unknown,
  token = mintCliToken(user, Date.now(), "desktop").token,
) {
  const response = await fetch(`${state.origin}/api/model-plans/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, any> }
}

describe("billing from the desktop app's Vector sign-in", () => {
  test("checkout and the billing portal accept the desktop's Vector account token", async () => {
    const checkout = await billing("checkout", { plan: "vector-10" })
    expect(checkout).toEqual({ status: 200, body: { url: sessions.get("cs_fixture1")!.url } })
    expect(checkout.body.url).toStartWith("https://checkout.stripe.com/")
    // The Stripe customer is created for the token's account, with its email.
    expect(calls.find((call) => call.path === "/v1/customers")?.body).toMatchObject({
      email: user.email,
      "metadata[vector_account_id]": user.id,
    })
    await paid()
    expect(await billing("portal", {})).toEqual({
      status: 200,
      body: { url: "https://billing.stripe.com/p/session/fixture" },
    })
    // Verified locally and against revocation: Supabase never sees the desktop's token.
    expect(calls.some((call) => call.path === "/auth/v1/user")).toBe(false)
  })

  test("a token pasted into a terminal, or from a desktop sign-in before 1.99.109, never opens the portal", async () => {
    // Before 1.99.109 the desktop's token carried no mark, the same as the one /auth/cli hands out to paste.
    const pasted = mintCliToken(user).token
    for (const body of [{}, { flow: "change" }, { flow: "cancel" }])
      expect(await billing("portal", body, pasted)).toEqual({
        status: 403,
        body: {
          error: {
            code: "DESKTOP_SIGN_IN_REQUIRED",
            message: "Sign in to Vector again to manage billing in the app.",
          },
        },
      })
    expect(calls.some((call) => call.path === "/v1/billing_portal/sessions")).toBe(false)
    // Buying needs a card typed into Stripe's own page, so a pasted token still opens checkout.
    expect(await billing("checkout", { plan: "vector-10" }, pasted)).toMatchObject({ status: 200 })
    // A forged mark fails the signature.
    const [payload] = pasted.slice(4).split(".")
    const marked = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), client: "desktop" }),
    ).toString("base64url")
    expect(await billing("portal", {}, `vct_${marked}.${pasted.split(".")[1]}`)).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID" } },
    })
  })

  test("plan changes require a desktop mark or web session and share a persistent ten-an-hour account limit", async () => {
    expect(await billing("change", { plan: "invalid" }, mintCliToken(user).token)).toMatchObject({
      status: 403,
      body: { error: { code: "DESKTOP_SIGN_IN_REQUIRED" } },
    })
    expect(await billing("change", { plan: "invalid" }, "not-a-session")).toMatchObject({ status: 401 })
    expect(await billing("change", { plan: "invalid" }, "browser-session")).toMatchObject({
      status: 400,
      body: { error: { code: "MODEL_PLAN_INVALID" } },
    })
    for (let attempt = 0; attempt < 9; attempt++)
      expect(await billing("change", { plan: "invalid" })).toMatchObject({ status: 400 })
    expect(await billing("change", { plan: "invalid" })).toMatchObject({
      status: 429,
      body: { error: { code: "RATE_LIMITED" } },
    })
    expect(calls.some((call) => call.path === "/v1/checkout/sessions")).toBe(false)
  })

  test("the old top-up route answers 410 to every token and sells nothing", async () => {
    const removed = {
      status: 410,
      body: {
        error: {
          code: "MODEL_TOPUP_REMOVED",
          message: "Vector Codium no longer sells top-ups. Choose or change a monthly plan instead.",
        },
      },
    }
    // What a desktop from before WP A04 sends, then a pasted token, a revoked one, and none at all.
    expect(await billing("topup", { pack: "codium-topup-10" })).toEqual(removed)
    expect(await billing("topup", { pack: "codium-topup-10" }, mintCliToken(user).token)).toEqual(removed)
    await redis(["SET", `vector:cli-revoked:${user.id}`, "1"])
    expect(await billing("topup", { pack: "codium-topup-10" })).toEqual(removed)
    expect(await billing("topup", {}, "")).toEqual(removed)
    expect(sessions.size).toBe(0)
    expect(calls.some((call) => call.path.startsWith("/v1/"))).toBe(false)
  })

  test("a revoked, expired or forged token is refused, and the website's browser session still works", async () => {
    await paid()
    const expired = mintCliToken(user, Date.now() - 91 * 24 * 60 * 60 * 1000).token
    expect(await billing("portal", {}, expired)).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_EXPIRED" } },
    })
    expect((await billing("portal", {}, `${mintCliToken(user).token}x`)).status).toBe(401)
    await redis(["SET", `vector:cli-revoked:${user.id}`, "1"])
    expect(await billing("checkout", { plan: "vector-10" })).toMatchObject({
      status: 401,
      body: { error: { code: "CLI_TOKEN_INVALID" } },
    })
    expect(sessions.size).toBe(0)
    // The website is unchanged: its Supabase session opens the portal.
    expect(await billing("portal", {}, "browser-session")).toMatchObject({ status: 200 })
    expect((await billing("portal", {}, "not-a-session")).status).toBe(401)
  })

  test("while new purchases are off, the token still opens billing management but buys nothing", async () => {
    await paid()
    process.env.MODEL_PLANS_ENABLED = "false"
    expect(await billing("checkout", { plan: "vector-10" })).toMatchObject({
      status: 503,
      body: { error: { code: "MODEL_PLANS_DISABLED" } },
    })
    expect(await billing("portal", {})).toMatchObject({ status: 200 })
    expect(sessions.size).toBe(0)
  })
})

describe("Codium portal compatibility and cancellation", () => {
  const portalSession = () => calls.findLast((call) => call.path === "/v1/billing_portal/sessions")?.body

  test("the portal always uses the no-change configuration, including when sales are paused", async () => {
    await paid()
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_changes"
    await modelPlanPortal(user.id, fetcher)
    expect(portalSession()).toMatchObject({ configuration: "bpc_fixture" })

    process.env.MODEL_PLANS_ENABLED = "false"
    await modelPlanPortal(user.id, fetcher)
    expect(portalSession()).toMatchObject({ configuration: "bpc_fixture" })
    await expect(modelPlanPortal(user.id, fetcher, { flow: "change" })).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
    })

    // Paused sales keep plan changes closed too, though the card, invoices and cancellation stay reachable.
    process.env.MODEL_PLANS_ENABLED = "true"
    await redis([
      "SET",
      "vector:codium:test:funding",
      JSON.stringify({
        status: "paused",
        reason: "short",
        checkedAt: Date.now(),
        since: Date.now(),
        balance: 0,
        owed: 0,
        required: 0,
        keys: 0,
      }),
    ])
    await modelPlanPortal(user.id, fetcher)
    expect(portalSession()).toMatchObject({ configuration: "bpc_fixture" })
    expect(await modelPlanPortal(user.id, fetcher, { flow: "cancel" })).toEqual({
      url: "https://billing.stripe.com/p/session/fixture",
    })

    // Without the second configuration, nothing offers plan changes.
    delete process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID
    await expect(modelPlanPortal(user.id, fetcher, { flow: "change" })).rejects.toMatchObject({ statusCode: 409 })
  })

  test("payment_method_update opens directly over HTTP without a paid plan or service sales", async () => {
    process.env.MODEL_PLANS_ENABLED = "false"
    delete process.env.OPENROUTER_MANAGEMENT_KEY
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_changes"
    await redis([
      "SET",
      accountKey,
      JSON.stringify({ customer: "cus_fixture", downgrade: { plan: "vector-10", token: "keep-schedule" } }),
    ])
    await redis(["SET", "vector:codium:test:switch:sales", "off"])
    await redis(["SET", "vector:codium:test:switch:codium", "off"])
    for (const pastDue of [false, true]) {
      state.subscriptions = pastDue ? [{ ...subscription(), status: "past_due" }] : []
      expect(
        await billing("portal", { flow: "payment_method_update" }, pastDue ? "browser-session" : undefined),
      ).toEqual({
        status: 200,
        body: { url: "https://billing.stripe.com/p/session/fixture" },
      })
      expect(portalSession()).toMatchObject({
        customer: "cus_fixture",
        configuration: "bpc_fixture",
        "flow_data[type]": "payment_method_update",
        "flow_data[after_completion][type]": "redirect",
        "flow_data[after_completion][redirect][return_url]": "https://vectordev.ai/account?model_plan=updated",
      })
      expect(portalSession()).not.toHaveProperty("flow_data[subscription_cancel][subscription]")
      expect(portalSession()).not.toHaveProperty("flow_data[payment_method_update][subscription]")
    }
    expect(
      calls.some((call) => call.path === "/v1/subscriptions" || call.path.startsWith("/v1/subscription_schedules")),
    ).toBe(false)
    expect(JSON.parse(String(await redis(["GET", accountKey]))).downgrade).toEqual({
      plan: "vector-10",
      token: "keep-schedule",
    })
  })

  test("Vector opens the portal straight at changing or cancelling the paid plan", async () => {
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_changes"
    await redis(["SET", accountKey, JSON.stringify({ customer: "cus_fixture" })])
    await expect(modelPlanPortal(user.id, fetcher, { flow: "change" })).rejects.toMatchObject({
      statusCode: 409,
      code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
      message: "Change plans on vectordev.ai/account.",
    })
    await expect(modelPlanPortal(user.id, fetcher, { flow: "cancel" })).rejects.toMatchObject({
      statusCode: 404,
      code: "MODEL_PLAN_MISSING",
      message: "There is no paid Codium plan to cancel.",
    })
    await paid()
    expect(await billing("portal", { flow: "change" })).toMatchObject({
      status: 409,
      body: { error: { code: "MODEL_PLAN_CHANGE_UNAVAILABLE" } },
    })
    await billing("portal", { flow: "cancel" })
    expect(portalSession()).toMatchObject({
      "flow_data[type]": "subscription_cancel",
      "flow_data[subscription_cancel][subscription]": "sub_fixture",
      "flow_data[after_completion][redirect][return_url]": "https://vectordev.ai/account?model_plan=ending",
    })
    // A smaller plan chosen earlier waits in a schedule for the renewal date; Stripe changes nothing more until then.
    state.subscriptions[0]!.schedule = "sub_sched_fixture"
    const opened = calls.filter((call) => call.path === "/v1/billing_portal/sessions").length
    expect(await billing("portal", { flow: "change" })).toMatchObject({
      status: 409,
      body: { error: { code: "MODEL_PLAN_CHANGE_UNAVAILABLE" } },
    })
    delete state.subscriptions[0]!.schedule
    state.subscriptions[0]!.cancel_at_period_end = true
    expect(await billing("portal", { flow: "cancel" })).toMatchObject({
      status: 409,
      body: { error: { code: "MODEL_PLAN_ENDING" } },
    })
    // A plan that is ending cannot be changed either; the person chooses a plan again once it ends.
    expect(await billing("portal", { flow: "change" })).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
          message: "Change plans on vectordev.ai/account.",
        },
      },
    })
    expect(calls.filter((call) => call.path === "/v1/billing_portal/sessions")).toHaveLength(opened)
    expect(await billing("portal", { flow: "upgrade" })).toMatchObject({
      status: 400,
      body: { error: { code: "BILLING_FLOW_INVALID" } },
    })
  })

  test("a plan changed in the portal grants the new plan's credits, and an unchanged one keeps what it was sold", () => {
    const start = Math.floor(Date.now() / 1000) - 60
    const end = start + 30 * 24 * 60 * 60
    const sold = {
      ...subscription(start, end),
      metadata: { vector_account_id: user.id, vector_plan: "vector-10", vector_model_credits_usd: "4" },
    }
    expect(paidModelPlan(sold, user.id)?.plan).toMatchObject({ id: "vector-10", credits: 4 })
    // An upgrade starts a new month on the bigger plan, invoiced in full; the metadata still names the old plan.
    const upgraded = {
      ...sold,
      items: {
        data: [
          {
            ...sold.items.data[0]!,
            price: { ...sold.items.data[0]!.price, id: "price_fixture100", unit_amount: 10_000 },
          },
        ],
      },
      latest_invoice: {
        ...sold.latest_invoice,
        amount_paid: 10_000,
        lines: { data: [{ price: { id: "price_fixture100" }, period: { start, end }, proration: false }] },
      },
    }
    expect(paidModelPlan(upgraded, user.id)?.plan).toMatchObject({ id: "vector-100", credits: 60 })
    // A prorated charge pays for part of a month, which Codium never grants.
    const prorated = {
      ...upgraded,
      latest_invoice: {
        ...upgraded.latest_invoice,
        amount_paid: 6_000,
        lines: { data: [{ price: { id: "price_fixture100" }, period: { start, end }, proration: true }] },
      },
    }
    expect(paidModelPlan(prorated, user.id)).toBeUndefined()
  })
})

describe("model plan account deletion", () => {
  test("expires pending checkout, revokes paid access, and durably blocks reactivation across cleanup retries", async () => {
    await modelPlanCheckout(user, "vector-10", fetcher)
    state.subscriptions = [subscription()]
    await modelPlanCredential(user.id, fetcher)
    await cancelModelPlanAccount(user.id, fetcher)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(state.subscriptions[0]!.status).toBe("canceled")
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
    await cancelModelPlanAccount(user.id, fetcher)
    expect(calls.filter((call) => call.path.endsWith("/expire"))).toHaveLength(1)
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1)

    // A stale upstream entitlement or key response must not undo local closure.
    state.subscriptions[0]!.status = "active"
    keys.get("hash_fixture1")!.data.disabled = false
    calls.length = 0
    expect(await modelPlanStatus(user.id, fetcher)).toEqual({
      active: false,
      customer: true,
      access: false,
    })
    await expect(modelPlanCheckout(user, "vector-50", fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
      statusCode: 409,
    })
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_ACCOUNT_CLOSING",
      statusCode: 409,
    })
    expect(calls).toHaveLength(0)
    expect(keys.size).toBe(1)
    expect(sessions.size).toBe(1)
  })

  test("discovers and expires an open checkout whose creation response was lost", async () => {
    state.loseCheckoutResponse = true
    await expect(modelPlanCheckout(user, "vector-10", fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(await readModelPlanAccount(user.id, fetcher)).not.toHaveProperty("checkout")
    expect(sessions.get("cs_fixture1")?.status).toBe("open")
    await cancelModelPlanAccount(user.id, fetcher)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
  })

  test("does not perform external cleanup before closure is durably recorded", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    calls.length = 0
    state.failClosingWrite = true
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ statusCode: 503 })
    expect(calls).toHaveLength(0)
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(false)
    expect(state.subscriptions[0]!.status).toBe("active")
    expect(await readModelPlanAccount(user.id, fetcher)).not.toHaveProperty("closing")
    state.failClosingWrite = false
    await cancelModelPlanAccount(user.id, fetcher)
    expect(state.subscriptions[0]!.status).toBe("canceled")
  })

  test("missing billing credentials cannot silently complete cleanup for an existing or unverifiable account", async () => {
    delete process.env.STRIPE_SECRET_KEY
    expect(await cancelModelPlanAccount(user.id, fetcher)).toBeUndefined()
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture"
    await paid()
    await modelPlanCredential(user.id, fetcher)
    delete process.env.STRIPE_SECRET_KEY
    calls.length = 0
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({
      code: "BILLING_UNAVAILABLE",
      statusCode: 503,
    })
    expect(state.subscriptions[0]!.status).toBe("active")
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(false)
    expect(calls).toHaveLength(0)
    delete process.env.KV_REST_API_URL
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ statusCode: 503 })
  })

  test("checkout expiry failure blocks completed cleanup and can be retried without reopening access", async () => {
    await modelPlanCheckout(user, "vector-10", fetcher)
    state.subscriptions = [subscription()]
    await modelPlanCredential(user.id, fetcher)
    state.failCheckoutExpiry = true
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
    expect(sessions.get("cs_fixture1")?.status).toBe("open")
    expect(state.subscriptions[0]!.status).toBe("active")
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0)
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_ACCOUNT_CLOSING" })
    state.failCheckoutExpiry = false
    await cancelModelPlanAccount(user.id, fetcher)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(state.subscriptions[0]!.status).toBe("canceled")
  })

  test("subscription cancellation failure preserves closure and retries the unfinished cancellation", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    state.failSubscriptionCancellation = true
    await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "BILLING_UPSTREAM" })
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    expect(await modelPlanStatus(user.id, fetcher)).toEqual({
      active: false,
      customer: true,
      access: false,
    })
    state.failSubscriptionCancellation = false
    await cancelModelPlanAccount(user.id, fetcher)
    expect(state.subscriptions[0]!.status).toBe("canceled")
    expect(keys.size).toBe(1)
  })

  test("incomplete or malformed checkout listings cannot be treated as completed cleanup", async () => {
    await paid()
    for (const mode of ["more", "invalid"]) {
      state.checkoutListMode = mode
      await expect(cancelModelPlanAccount(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_CLEANUP" })
      expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ closing: true })
      expect(state.subscriptions[0]!.status).toBe("active")
    }
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0)
    state.checkoutListMode = "normal"
    await cancelModelPlanAccount(user.id, fetcher)
    expect(state.subscriptions[0]!.status).toBe("canceled")
  })
})

describe("paid credential lifecycle", () => {
  test("persists only encrypted credentials and reuses the period key with a hard nonresetting cap", async () => {
    const subscription = await paid()
    const credential = (await modelPlanCredential(user.id, fetcher)).key
    expect(credential).toBe("fixture-paid-secret-1")
    expect(String(await redis(["GET", accountKey]))).not.toContain(credential)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      key: { hash: "hash_fixture1", subscription: subscription.id, credits: 5 },
    })
    expect(keys.get("hash_fixture1")?.data).toMatchObject({
      limit: 5,
      limit_reset: null,
      include_byok_in_limit: true,
      expires_at: keyExpiresAt(subscription.items.data[0]!.current_period_end),
    })
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe(credential)
    expect(keys.size).toBe(1)
    expect(mutations()).toHaveLength(1)
  })

  test("parallel paid-key reads do not serialize through a mutation lease", async () => {
    await paid()
    const credential = (await modelPlanCredential(user.id, fetcher)).key
    calls.length = 0
    commands.length = 0
    state.keyReadDelay = 25
    expect(
      await Promise.all(Array.from({ length: 8 }, async () => (await modelPlanCredential(user.id, fetcher)).key)),
    ).toEqual(Array(8).fill(credential))
    expect(mutations()).toHaveLength(0)
    expect(commands.every((command) => command[0] === "GET")).toBe(true)
    expect(calls.filter((call) => call.path === "/api/v1/keys/hash_fixture1")).toHaveLength(8)
  })

  test("same-period restoration re-enables the same key without clearing already charged usage", async () => {
    await paid()
    const credential = (await modelPlanCredential(user.id, fetcher)).key
    Object.assign(keys.get("hash_fixture1")!.data, { disabled: true, usage: 3.5 })
    expect((await modelPlanCredential(user.id, fetcher)).key).toBe(credential)
    expect(keys.size).toBe(1)
    expect(keys.get("hash_fixture1")?.data).toMatchObject({ disabled: false, usage: 3.5, limit: 5, limit_reset: null })
    expect(calls.findLast((call) => call.method === "PATCH")?.body).not.toHaveProperty("usage")
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ active: true, used: 3.5, remaining: 1.5 })
  })

  test("renewal disables the old key before issuing a new period allowance", async () => {
    const current = await paid()
    const first = (await modelPlanCredential(user.id, fetcher)).key
    const start = current.items.data[0]!.current_period_end
    state.subscriptions = [subscription(start, start + 7200)]
    const next = (await modelPlanCredential(user.id, fetcher, (start + 1) * 1000)).key
    expect(next).not.toBe(first)
    expect(keys.size).toBe(2)
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    expect(mutations().map((call) => [call.method, call.path])).toEqual([
      ["POST", "/api/v1/keys"],
      ["PATCH", "/api/v1/keys/hash_fixture1"],
      ["POST", "/api/v1/keys"],
    ])
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({ key: { start, hash: "hash_fixture2" } })
  })

  test("unpaid, refunded and disputed periods cannot provision or reuse a credential", async () => {
    const current = await paid()
    current.latest_invoice.paid = false
    expect(await modelPlanStatus(user.id, fetcher)).toEqual({
      active: false,
      customer: true,
      access: false,
    })
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(keys.size).toBe(0)
    current.latest_invoice.paid = true
    await modelPlanCredential(user.id, fetcher)
    current.latest_invoice.charge.refunded = true
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(keys.get("hash_fixture1")?.data.disabled).toBe(true)
    current.latest_invoice.charge.refunded = false
    current.latest_invoice.charge.disputed = true
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_PAYMENT_REQUIRED" })
    expect(keys.size).toBe(1)
  })

  test("exhaustion and unknown usage fail closed instead of creating a fresh allowance", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    keys.get("hash_fixture1")!.data.usage = 5
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
      statusCode: 402,
    })
    delete keys.get("hash_fixture1")!.data.usage
    await expect(modelPlanCredential(user.id, fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_KEY_INVALID" })
    expect(keys.size).toBe(1)
    expect(mutations()).toHaveLength(1)
  })
})

describe("model plan HTTP inference", () => {
  test("a title request debits its account key and the authenticated balance reflects the charge", async () => {
    await paid()
    state.charge = 0.000031
    const response = await chat({
      model: model.id,
      max_tokens: 64,
      messages: [{ role: "user", content: "Generate a concise title" }],
    })
    expect(response.status).toBe(200)
    // The provider's USD charge comes off the credits but never reaches Vector; the tokens do. Nor does the provider
    // that served the request, whose published price would give the charge away.
    const text = await response.text()
    expect(text).toContain('"completion_tokens":6')
    expect(text).toContain('"id":"gen-fixture"')
    for (const leak of ["cost", "is_byok", "PRIVATE-PROVIDER", "fp_private", "PRIVATE-REASON"])
      expect(text).not.toContain(leak)
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ used: 0.000031, remaining: 4.999969 })
    expect(chats()).toHaveLength(1)
    state.charge = 0
  })

  test("requires a current nonrevoked CLI identity and authoritative persistent storage", async () => {
    await paid()
    expect((await chat(undefined, "invalid")).status).toBe(401)
    expect((await chat(undefined, mintCliToken(user, Date.now() - 100 * 86400000).token)).status).toBe(401)
    await redis(["SET", `vector:cli-revoked:${user.id}`, "1"])
    expect((await chat()).status).toBe(401)
    await redis(["DEL", `vector:cli-revoked:${user.id}`])
    expect((await chat(undefined, undefined, { origin: "https://foreign.example" })).status).toBe(403)
    state.unavailable = true
    expect((await chat()).status).toBe(503)
    state.unavailable = false
    delete process.env.KV_REST_API_URL
    expect((await chat()).status).toBe(503)
    expect(chats()).toHaveLength(0)
  })

  test("streams split CRLF frames, forwards only the account key, and pins model/provider limits", async () => {
    await paid()
    const response = await chat({
      model: model.id,
      messages: [{ role: "user", content: "fixture", extra: "strip me" }],
      user: "attacker",
      max_tokens: 100000,
      provider: { allow_fallbacks: true, data_collection: "allow" },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"content":"fixture"')
    expect(chats()).toHaveLength(1)
    expect(chats()[0]!.headers.get("authorization")).toBe("Bearer fixture-paid-secret-1")
    expect(chats()[0]!.body).toMatchObject({
      model: model.id,
      user: createHash("sha256").update(user.id).digest("hex"),
      max_tokens: 2048,
      stream: true,
      provider: {
        data_collection: "deny",
        zdr: true,
        require_parameters: true,
        max_price: { prompt: 1, completion: 2, request: 0 },
      },
    })
    expect(JSON.stringify(chats()[0]!.body)).not.toContain("strip me")
    expect(JSON.stringify(chats()[0]!.body)).not.toContain("vct_")
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ active: true, used: 0, remaining: 5 })
  })

  test("enforces the real atomic per-user minute cap under concurrent requests", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    const responses = await Promise.all(Array.from({ length: 34 }, () => chat()))
    expect(responses.filter((response) => response.status === 200)).toHaveLength(30)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(4)
    expect(chats()).toHaveLength(30)
    const rejected = responses.find((response) => response.status === 429)!
    expect(await rejected.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
    expect(Number(rejected.headers.get("retry-after"))).toBeGreaterThan(0)
    expect(Number(rejected.headers.get("x-ratelimit-reset")) * 1000).toBeGreaterThan(Date.now())
  })

  test("structured-output schemas count toward the input context and cost bound", async () => {
    await paid()
    const response = await chat({
      model: model.id,
      messages: [{ role: "user", content: "Return an object" }],
      max_tokens: 1,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fixture",
          schema: { type: "object", description: "x".repeat(model.contextLength * 4) },
        },
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_CONTEXT" } })
    expect(chats()).toHaveLength(0)
    expect(keys.size).toBe(0)
  })

  test("exhausted paid credits return payment-required without an inference request", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    keys.get("hash_fixture1")!.data.usage = 5
    const response = await chat()
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLAN_EXHAUSTED" } })
    expect(chats()).toHaveLength(0)
  })

  test("every shortfall gets one answer, checked against the model's largest request whatever the request's size", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    const answer = {
      error: {
        code: "MODEL_PLAN_EXHAUSTED",
        message:
          "This month's Vector Codium usage cannot cover this model's largest request right now. Wait for running requests to finish, or choose a lighter model. Your Codium usage renews each billing period.",
      },
    }
    // The fixture model's largest request, 8,192 context tokens at $1 and 2,048 output tokens at $2 per million,
    // is $0.012288. The request's own size never changes the check, so a client cannot vary max_tokens to read the
    // balance back.
    keys.get("hash_fixture1")!.data.usage = 5 - 0.012
    for (const body of [undefined, { model: model.id, max_tokens: 1, messages: [{ role: "user", content: "A" }] }]) {
      const refused = await chat(body)
      expect(refused.status).toBe(402)
      const text = await refused.json()
      expect(text).toEqual(answer)
      // Vector's client offers Buy credits with it, as for any shortfall.
      expect(ModelPlans.gatewayFailure(402, JSON.stringify(text))).toMatchObject({ kind: "credits" })
    }
    expect(chats()).toHaveLength(0)
    // The account's status agrees: too few left for any request, not merely running low.
    expect(modelPlanBalance(await modelPlanStatus(user.id, fetcher))).toMatchObject({ empty: true, low: false })
    // Just enough for the largest request is served, whatever this request asks for.
    keys.get("hash_fixture1")!.data.usage = 5 - 0.0123
    const served = await chat()
    expect(served.status).toBe(200)
    await served.text()
    expect(chats()).toHaveLength(1)
    // Credits that are used up get the same answer.
    keys.get("hash_fixture1")!.data.usage = 5
    expect(await (await chat()).json()).toEqual(answer)
    expect(chats()).toHaveLength(1)
    // The served request settles its hold just after its answer ends, so wait for that before the next test.
    const pool = heldKey
    for (let tries = 0; tries < 100; tries++) {
      const [member] = (await redis(["ZRANGE", pool, 0, -1])) as string[]
      if (member && Number(await redis(["ZSCORE", pool, member])) < Date.now() + 60_000) break
      await Bun.sleep(10)
    }
  })

  test("parallel requests hold their largest cost, so together they cannot spend past the balance", async () => {
    await paid()
    await modelPlanCredential(user.id, fetcher)
    // Each hold is "<ticket>:<purpose>:<runId or ->:<micro-dollars>". A request settles its hold just after its answer ends.
    const held = async (count: number, charge?: string) => {
      const members = async () => (await redis(["ZRANGE", heldKey, 0, -1])) as string[]
      for (let tries = 0; tries < 100; tries++) {
        const current = await members()
        if (current.length === count && current.every((member) => !charge || member.endsWith(`:${charge}`)))
          return current
        await Bun.sleep(10)
      }
      return members()
    }
    // Room for two of the fixture model's largest requests ($0.012288 each), not three.
    keys.get("hash_fixture1")!.data.usage = 5 - 0.03
    state.chatDelay = 100
    state.charge = 0.001
    const responses = await Promise.all(Array.from({ length: 5 }, () => chat()))
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 402, 402, 402])
    expect(chats()).toHaveLength(2)
    // Credits held by running requests get the same answer as any other shortfall.
    const refused = await responses.find((response) => response.status === 402)!.json()
    expect(refused).toEqual({
      error: {
        code: "MODEL_PLAN_EXHAUSTED",
        message:
          "This month's Vector Codium usage cannot cover this model's largest request right now. Wait for running requests to finish, or choose a lighter model. Your Codium usage renews each billing period.",
      },
    })
    // Finished requests keep only what they were charged, for a moment, until the key's usage shows it.
    expect(keys.get("hash_fixture1")!.data.usage).toBeCloseTo(4.972, 9)
    expect(await held(2, "1000")).toHaveLength(2)
    state.chatDelay = 0
    expect((await chat()).status).toBe(200)
    expect(await held(3, "1000")).toHaveLength(3)
    // A request the provider refuses releases its hold at once.
    keys.get("hash_fixture1")!.data.usage = 4
    state.upstreamStatus = 500
    expect((await chat()).status).toBe(503)
    expect(await held(3, "1000")).toHaveLength(3)
    expect(chats()).toHaveLength(4)
  })

  test("an answer that breaks off keeps its largest cost held, since the provider may still bill it", async () => {
    await paid()
    const pool = heldKey
    const members = async () => (await redis(["ZRANGE", pool, 0, -1])) as string[]
    state.charge = 0.001
    state.streamMode = "truncated"
    const broken = await chat()
    expect(await broken.text()).toContain('"code":"MODEL_PLAN_STREAM"')
    state.streamMode = "normal"
    expect((await chat()).status).toBe(200)
    // The finished answer settles to its charge just after it ends.
    for (let tries = 0; tries < 100 && !(await members()).some((member) => member.endsWith(":1000")); tries++)
      await Bun.sleep(10)
    const current = await members()
    expect(current).toHaveLength(2)
    const kept = current.find((member) => !member.endsWith(":1000"))
    if (!kept) throw new Error("Expected the broken answer's hold")
    // Still the model's largest request, held until it lapses 11 minutes after the request started, not 30 seconds.
    expect(kept.split(":").slice(1)).toEqual(["chat", "-", "12288"])
    expect(Number(await redis(["ZSCORE", pool, kept]))).toBeGreaterThan(Date.now() + 600_000)
  })

  test("normalizes upstream capacity and busy failures without leaking credentials or retrying", async () => {
    await paid()
    for (const status of [402, 429, 500]) {
      state.upstreamStatus = status
      const response = await chat()
      expect(response.status).toBe(status === 500 ? 503 : status)
      const body = await response.text()
      expect(body).not.toContain("PRIVATE")
      expect(body).not.toContain("fixture-paid-secret")
    }
    expect(chats()).toHaveLength(3)
  })

  test("late errors and truncated or invalid streams end with a sanitized error and DONE", async () => {
    await paid()
    for (const mode of ["error", "truncated", "invalid"]) {
      state.streamMode = mode
      const response = await chat()
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(body).toContain('"content":"fixture"')
      expect(body).toContain('"code":"MODEL_PLAN_STREAM"')
      expect(body.endsWith("data: [DONE]\n\n")).toBe(true)
      expect(body).not.toContain("PRIVATE")
      expect(body).not.toContain("fixture-paid-secret")
    }
    expect(chats()).toHaveLength(3)
  })
})

describe("Codium credits used from Vector", () => {
  // Vector's own client code, sending what it would send to vectordev.ai to the gateway handlers here instead.
  const forward = (url: string, init: RequestInit) => {
    if (!url.startsWith(`${ModelPlanStatus.SITE}/api/model-plans/`)) throw new Error(`Unexpected destination ${url}`)
    return fetch(`${state.origin}${url.slice(ModelPlanStatus.SITE.length)}`, init)
  }
  const turn = (token: string) => {
    const catalog = ModelPlans.createClient({ request: forward })
    return ModelPlans.createFetch({
      modelID: model.id,
      credential: async () => token,
      catalog: (value) => catalog.catalog(value, { wait: true }),
      request: forward,
    })("https://vectordev.ai/api/model-plans/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "Fix the failing test" }] }),
    })
  }

  test("a signed-in turn is debited from the monthly credits, and running out stops at Buy credits", async () => {
    await paid()
    const token = mintCliToken(user).token
    const catalog = await ModelPlans.createClient({ request: forward }).catalog(token, { force: true })
    expect(catalog).toEqual({
      enabled: true,
      models: [
        { id: model.id, name: model.name, contextLength: model.contextLength, maxOutputTokens: model.maxOutputTokens },
      ],
    })

    state.charge = 0.5
    const answer = await turn(token)
    expect(answer.status).toBe(200)
    const usage = (await answer.text())
      .split("\n\n")
      .map((frame) => frame.replace(/^data: /, ""))
      .filter((frame) => frame.startsWith("{"))
      .map((frame) => JSON.parse(frame).usage)
      .find((usage) => usage !== undefined)
    // The account's key was charged; Vector gets the tokens, never the dollars, which beside the share of the plan
    // used would reveal its allowance.
    expect(usage).toEqual({ prompt_tokens: 200, completion_tokens: 6, total_tokens: 206 })
    expect(keys.get("hash_fixture1")!.data.usage).toBe(0.5)
    expect(chats()).toHaveLength(1)
    expect(chats()[0]!.headers.get("authorization")).toBe("Bearer fixture-paid-secret-1")
    expect(JSON.stringify(chats()[0]!.body)).not.toContain(token)
    const status = await ModelPlanStatus.fetchStatus(token, forward)
    expect(status).toMatchObject({ signedIn: true, enabled: true, plan: { name: "Plus", left: 0.9 } })
    expect(ModelPlanStatus.describe(status)[0]).toContain("90% of this month's credits left")

    // The monthly credits run out: the next turn is refused before any model request, with Buy credits.
    keys.get("hash_fixture1")!.data.usage = 5
    const refused = await turn(token)
    expect(refused.status).toBe(402)
    expect(ModelPlans.gatewayFailure(refused.status, await refused.text())).toMatchObject({
      kind: "credits",
      message: expect.stringContaining(`Buy credits at ${ModelPlanStatus.PURCHASE_URL}`),
    })
    expect(chats()).toHaveLength(1)
    const empty = await ModelPlanStatus.fetchStatus(token, forward)
    expect(empty).toMatchObject({ plan: { left: 0 }, empty: true })
    expect(ModelPlanStatus.notice(empty)?.kind).toBe("empty")
    state.charge = 0
  })

  test("the status Vector reads carries shares and flags, never an amount of credits", async () => {
    const current = await paid()
    await modelPlanCredential(user.id, fetcher)
    const token = mintCliToken(user).token
    const read = async () =>
      (await forward(ModelPlanStatus.STATUS_URL, { headers: { authorization: `Bearer ${token}` } })).json()
    keys.get("hash_fixture1")!.data.usage = 1.234
    const body = await read()
    expect(body).toEqual({
      enabled: true,
      active: true,
      customer: true,
      access: true,
      plan: {
        id: "vector-10",
        name: "Plus",
        left: 0.75,
        renewsAt: current.items.data[0]!.current_period_end * 1000,
        cancelAtPeriodEnd: false,
      },
      purchased: { bought: false },
      empty: false,
      low: false,
    })
    // Neither the allowance (5), what was used nor what is left reaches the app, the CLI or the browser.
    expect(JSON.stringify(body)).not.toMatch(/credits|used|remaining|wallet|1\.234|3\.766|"5"|:5[,}]/)

    // Running low is a tenth of this month's credits; too few for the catalog's cheapest largest request
    // ($0.012288 for the fixture model) is empty, the point where the gateway refuses every request.
    keys.get("hash_fixture1")!.data.usage = 4.51
    expect(await read()).toMatchObject({ plan: { left: 0.1 }, empty: false, low: true })
    keys.get("hash_fixture1")!.data.usage = 5 - 0.013
    expect(await read()).toMatchObject({ plan: { left: 0 }, empty: false, low: true })
    keys.get("hash_fixture1")!.data.usage = 5 - 0.012
    expect(await read()).toMatchObject({ plan: { left: 0 }, empty: true, low: false })
    // A key whose usage cannot be read leaves the share unknown and raises no flag.
    delete keys.get("hash_fixture1")!.data.usage
    const unknown = await read()
    expect(unknown).toMatchObject({ empty: false, low: false })
    expect(unknown.plan).not.toHaveProperty("left")
  })

  test("while sales are off Vector lists no Codium and a turn sends nothing", async () => {
    await paid()
    process.env.MODEL_PLANS_ENABLED = "false"
    const token = mintCliToken(user).token
    expect(await ModelPlans.createClient({ request: forward }).catalog(token, { force: true })).toEqual({
      enabled: false,
      models: [],
    })
    const refused = await turn(token)
    expect(ModelPlans.gatewayFailure(refused.status, await refused.text())).toMatchObject({ kind: "unavailable" })
    expect(chats()).toHaveLength(0)
    const status = await ModelPlanStatus.fetchStatus(token, forward)
    expect(ModelPlanStatus.notice(status)).toEqual({ kind: "unavailable", text: "Vector Codium is not available yet." })
  })
})
