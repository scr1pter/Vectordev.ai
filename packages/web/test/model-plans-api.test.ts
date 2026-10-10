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
  modelPlanCheckout,
  modelPlanCredential,
  modelPlanPortal,
  modelPlanStatus,
  readModelPlanAccount,
} from "../../../api/_lib/model-plan-account"
import { handleModelPlanChat } from "../../../api/_lib/model-plan-chat"

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
const accountKey = `vector:model-plans:account:${user.id}`
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
  "MODEL_PLANS_ENABLED",
  "MODEL_PLAN_MODELS_JSON",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_MODEL_PLAN_WEBHOOK_SECRET",
  "STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID",
  "OPENROUTER_MANAGEMENT_KEY",
  "VECTOR_CLI_TOKEN_SECRET",
  "VECTOR_ABUSE_SECRET",
  "VECTOR_PUBLIC_URL",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  ...[10, 20, 50, 100, 200].flatMap((price) => [
    `MODEL_PLAN_${price}_CREDITS_USD`,
    `STRIPE_MODEL_PLAN_${price}_PRICE_ID`,
  ]),
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
  keyReadDelay: 0,
  subscriptions: [] as ReturnType<typeof subscription>[],
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
    if (url.pathname.startsWith("/v1/")) {
      expect(request.headers.get("authorization")).toBe("Bearer sk_fixture")
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
      const mode = state.streamMode
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"fixture"}}]}\r'))
            controller.enqueue(encoder.encode("\n\r\n"))
            if (mode === "error")
              controller.enqueue(
                encoder.encode('data: {"error":{"code":402,"message":"PRIVATE fixture-paid-secret-1"}}\n\n'),
              )
            if (mode === "invalid") controller.enqueue(encoder.encode("data: not-json\n\n"))
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
  Object.assign(process.env, {
    NODE_ENV: "development",
    MODEL_PLANS_ENABLED: "true",
    MODEL_PLAN_MODELS_JSON: JSON.stringify([model]),
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "ab".repeat(32),
    STRIPE_SECRET_KEY: "sk_fixture",
    STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    VECTOR_CLI_TOKEN_SECRET: "fixture-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
    VECTOR_PUBLIC_URL: "https://vectordev.ai",
    KV_REST_API_URL: new URL("/redis", upstream.url).href,
    KV_REST_API_TOKEN: "fixture-kv-token",
  })
  delete process.env.VERCEL_ENV
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  for (const price of [10, 20, 50, 100, 200]) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = String(price / 2)
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
    keyReadDelay: 0,
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
  test("replaces a pending subscription checkout when its allowance or Stripe price changes", async () => {
    const first = await modelPlanCheckout(user, "vector-10", fetcher)
    process.env.MODEL_PLAN_10_CREDITS_USD = "6"
    const second = await modelPlanCheckout(user, "vector-10", fetcher)
    expect(second.url).not.toBe(first.url)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(sessions.get("cs_fixture2")?.metadata.vector_model_credits_usd).toBe("6")
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
    const next = await modelPlanCheckout(user, "vector-20", fetcher)
    expect(next.url).not.toBe(first.url)
    expect(sessions.get("cs_fixture1")?.status).toBe("expired")
    expect(sessions.size).toBe(2)
    const expire = calls.findIndex((call) => call.path.endsWith("/cs_fixture1/expire"))
    expect(calls.findLastIndex((call) => call.path === "/v1/checkout/sessions")).toBeGreaterThan(expire)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      customer: "cus_fixture",
      checkout: { id: "cs_fixture2", plan: "vector-20", url: next.url },
    })
    expect(calls.filter((call) => call.path === "/v1/customers")).toHaveLength(1)
    expect(calls.find((call) => call.path === "/v1/checkout/sessions")?.body["payment_method_types[0]"]).toBe("card")
    expect(commands.some((command) => command[0] === "EVAL" && String(command[1]).includes("PTTL"))).toBe(true)
    expect(await redis(["KEYS", "vector:billing-mutation:*"])).toEqual([])
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
    await expect(modelPlanCheckout(user, "vector-20", fetcher)).rejects.toMatchObject({ code: "MODEL_PLAN_EXISTS" })
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
    await expect(modelPlanCheckout(user, "vector-20", fetcher)).rejects.toMatchObject({
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
      wallet: { credits: 0, used: 0, remaining: 0 },
    })
    await expect(modelPlanCheckout(user, "vector-20", fetcher)).rejects.toMatchObject({
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
    process.env.STRIPE_SECRET_KEY = "sk_fixture"
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
      wallet: { credits: 0, used: 0, remaining: 0 },
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
    const credential = await modelPlanCredential(user.id, fetcher)
    expect(credential).toBe("fixture-paid-secret-1")
    expect(String(await redis(["GET", accountKey]))).not.toContain(credential)
    expect(await readModelPlanAccount(user.id, fetcher)).toMatchObject({
      key: { hash: "hash_fixture1", subscription: subscription.id, credits: 5 },
    })
    expect(keys.get("hash_fixture1")?.data).toMatchObject({
      limit: 5,
      limit_reset: null,
      include_byok_in_limit: true,
      expires_at: new Date(subscription.items.data[0]!.current_period_end * 1000).toISOString(),
    })
    expect(await modelPlanCredential(user.id, fetcher)).toBe(credential)
    expect(keys.size).toBe(1)
    expect(mutations()).toHaveLength(1)
  })

  test("parallel paid-key reads do not serialize through a mutation lease", async () => {
    await paid()
    const credential = await modelPlanCredential(user.id, fetcher)
    calls.length = 0
    commands.length = 0
    state.keyReadDelay = 25
    expect(await Promise.all(Array.from({ length: 8 }, () => modelPlanCredential(user.id, fetcher)))).toEqual(
      Array(8).fill(credential),
    )
    expect(mutations()).toHaveLength(0)
    expect(commands.every((command) => command[0] === "GET")).toBe(true)
    expect(calls.filter((call) => call.path === "/api/v1/keys/hash_fixture1")).toHaveLength(8)
  })

  test("same-period restoration re-enables the same key without clearing already charged usage", async () => {
    await paid()
    const credential = await modelPlanCredential(user.id, fetcher)
    Object.assign(keys.get("hash_fixture1")!.data, { disabled: true, usage: 3.5 })
    expect(await modelPlanCredential(user.id, fetcher)).toBe(credential)
    expect(keys.size).toBe(1)
    expect(keys.get("hash_fixture1")?.data).toMatchObject({ disabled: false, usage: 3.5, limit: 5, limit_reset: null })
    expect(calls.findLast((call) => call.method === "PATCH")?.body).not.toHaveProperty("usage")
    expect(await modelPlanStatus(user.id, fetcher)).toMatchObject({ active: true, used: 3.5, remaining: 1.5 })
  })

  test("renewal disables the old key before issuing a new period allowance", async () => {
    const current = await paid()
    const first = await modelPlanCredential(user.id, fetcher)
    const start = current.items.data[0]!.current_period_end
    state.subscriptions = [subscription(start, start + 7200)]
    const next = await modelPlanCredential(user.id, fetcher, (start + 1) * 1000)
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
      wallet: { credits: 0, used: 0, remaining: 0 },
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
        max_price: { prompt: 1, completion: 2, request: 0, image: 0 },
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
        json_schema: { name: "fixture", schema: { type: "object", description: "x".repeat(model.contextLength) } },
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
