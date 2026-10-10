import { afterAll, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMError } from "@vectordevai/llm"
import { LLMClient, RequestExecutor } from "@vectordevai/llm/route"
import { FreeModels } from "../src/free-models"
import { ModelPlans } from "../src/model-plans"
import { ModelPlanStatus } from "../src/model-plan-status"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { modelPlanRoute } from "../src/session/runner/model-plan-route"
import { SessionRunnerModel } from "../src/session/runner/model"
import { codiumGateway, codiumModel as model } from "./fixture/codium-gateway"

const token = "vct_synthetic-private-account.token"
const gateway = codiumGateway(token)
afterAll(() => gateway.stop())

const active = { enabled: true, models: [model] }
const off = { enabled: false, models: [] }
const info = ModelV2.Info.make({
  ...ModelV2.Info.empty(ProviderV2.ID.make(ModelPlans.PROVIDER_ID), ModelV2.ID.make(model.id)),
  api: {
    id: ModelV2.ID.make("different/model"),
    type: "aisdk",
    package: "@ai-sdk/openai-compatible",
    url: "https://attacker.invalid",
  },
  limit: { context: 32_000, output: 4096 },
})
const service = (catalog = active) =>
  ModelPlans.Service.of({ catalog: () => Effect.succeed(catalog), request: gateway.forward })
const credentials = (value: string | undefined = token) =>
  FreeModels.CredentialsService.of({ get: () => Effect.succeed(value) })

// Runs one V2 provider turn through the native Codium route against the local gateway.
const stream = (route: ReturnType<typeof modelPlanRoute>) =>
  Effect.runPromise(
    LLMClient.stream(
      LLM.request({
        model: route,
        prompt: "read src/a.ts",
        tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      }),
    ).pipe(
      Stream.runCollect,
      Effect.result,
      Effect.provide(LLMClient.layer.pipe(Layer.provide(RequestExecutor.fetchLayer))),
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign((input: RequestInfo | URL, init?: RequestInit) => gateway.forward(String(input), init), {
          preconnect: fetch.preconnect,
        }),
      ),
    ),
  )

test("plan catalogs require account authentication, coalesce requests and isolate account caches", async () => {
  const calls: RequestInit[] = []
  const client = ModelPlans.createClient({
    request: async (url, init) => {
      expect(url).toBe(ModelPlans.CATALOG_URL)
      expect(init.redirect).toBe("error")
      calls.push(init)
      return Response.json(new Headers(init.headers).get("authorization") === "Bearer account-a" ? active : off)
    },
  })
  expect(await client.catalog(undefined)).toEqual(off)
  expect(calls).toEqual([])
  expect(await Promise.all([client.catalog("account-a"), client.catalog("account-a")])).toEqual([active, active])
  expect(calls).toHaveLength(1)
  expect(await client.catalog("account-b")).toEqual(off)
  expect(await client.catalog("account-a")).toEqual(active)
  expect(calls).toHaveLength(2)
})

test("catalog refresh fails closed on revocation, network errors and malformed prices", async () => {
  const replies = [
    Response.json(active),
    new Response("revoked", { status: 403 }),
    Response.json({ enabled: true, models: [{ ...model, inputPrice: -1 }] }),
  ]
  const client = ModelPlans.createClient({
    request: async () => replies.shift() ?? Promise.reject(new Error("offline")),
  })
  expect(await client.catalog("account")).toEqual(active)
  expect(await client.catalog("account", true)).toEqual(off)
  expect(await client.catalog("account", true)).toEqual(off)
  expect(await client.catalog("account", true)).toEqual(off)
})

test("catalog caches are bounded and disabled mode makes no requests", async () => {
  const calls: string[] = []
  const client = ModelPlans.createClient({
    request: async (_url, init) => {
      calls.push(new Headers(init.headers).get("authorization")!)
      return Response.json(active)
    },
  })
  await Promise.all(Array.from({ length: 33 }, (_, index) => client.catalog(`account-${index}`)))
  await client.catalog("account-0")
  expect(calls).toHaveLength(34)
  expect(
    await ModelPlans.createClient({
      disabled: () => true,
      request: async () => {
        throw new Error("Disabled catalogs must not request the network")
      },
    }).catalog("account"),
  ).toEqual(off)
})

test("a hung catalog cannot stall model selection, and its late answer serves the next caller", async () => {
  const pending = Promise.withResolvers<Response>()
  const client = ModelPlans.createClient({ timeout: 5, request: () => pending.promise })
  expect(await client.catalog("account")).toEqual(off)
  pending.resolve(Response.json(active))
  await Bun.sleep(5)
  expect(await client.catalog("account")).toEqual(active)
})

test("the catalog reads the signed-in account's models from the gateway", async () => {
  const client = ModelPlans.createClient({ request: gateway.forward })
  expect(await client.catalog(token)).toEqual(active)
  expect(await client.catalog("vct_someone-else.token")).toEqual(off)
  gateway.state.mode = "disabled"
  expect(await client.catalog(token, true)).toEqual(off)
  gateway.state.mode = "ok"
})

test("legacy SDK transport fixes destination and credentials while enforcing the catalog model and token ceiling", async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const accounts = ["first-account", "second-account"]
  const request = ModelPlans.createFetch({
    modelID: model.id,
    credential: async () => accounts.shift(),
    catalog: async () => active,
    request: async (url, init) => {
      calls.push({ url, init })
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  for (const account of ["first-account", "second-account"]) {
    await request("https://attacker.invalid/chat", {
      headers: { Authorization: "injected", "x-private": "secret" },
      body: JSON.stringify({
        model: "different/expensive",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 100_000,
        models: ["fallback"],
        provider: { max_price: 100 },
        plugins: [{ id: "web" }],
        apiKey: "injected",
      }),
    })
    const call = calls.at(-1)!
    expect(call.url).toBe(ModelPlans.CHAT_URL)
    expect(call.init.redirect).toBe("error")
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${account}`)
    expect(new Headers(call.init.headers).get("x-private")).toBeNull()
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: model.id,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: model.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    })
  }
})

test("signed-out, disabled and retired selections fail before any request with a clear message", async () => {
  const requests: string[] = []
  const attempt = (credential: string | undefined, catalog: ModelPlans.Catalog) =>
    ModelPlans.createFetch({
      modelID: model.id,
      credential: async () => credential,
      catalog: async () => catalog,
      request: async (url) => {
        requests.push(url)
        return new Response()
      },
    })("https://vectordev.ai/api/model-plans/chat", { body: JSON.stringify({ messages: [{ role: "user" }] }) })
  await expect(attempt(undefined, active)).rejects.toThrow("Sign in to Vector to use Vector Codium")
  await expect(attempt(token, off)).rejects.toThrow("Vector Codium is not available right now")
  await expect(attempt(token, { enabled: true, models: [{ ...model, id: "vendor/other" }] })).rejects.toThrow(
    "no longer included in Vector Codium",
  )
  expect(requests).toEqual([])
})

test("native plan transport ignores project and request routing overlays and denies unavailable models", async () => {
  const catalogs = [active, off]
  const route = modelPlanRoute(
    info,
    ModelPlans.Service.of({ catalog: () => Effect.succeed(catalogs.shift()!), request: gateway.forward }),
    credentials("current-account"),
  )
  const request = LLM.request({
    model: route,
    prompt: "hello",
    http: {
      headers: { Authorization: "injected", "x-private": "secret" },
      query: { key: "secret" },
      body: { model: "different/model", provider: { max_price: 100 }, apiKey: "private" },
    },
  })
  const prepared = await Effect.runPromise(
    route.route.prepareTransport({ model: route.id, messages: [{ role: "user", content: "hello" }] }, request),
  )
  expect(prepared.request.url).toBe(ModelPlans.CHAT_URL)
  expect(prepared.request.headers.authorization).toBe("Bearer current-account")
  expect(prepared.request.headers["x-private"]).toBeUndefined()
  await expect(
    Effect.runPromise(
      route.route.prepareTransport({ model: route.id, messages: [{ role: "user", content: "hello" }] }, request),
    ),
  ).rejects.toThrow("Vector Codium is not available right now")
})

test("a native Codium turn streams text and a tool call and records the cost the gateway billed", async () => {
  const route = SessionRunnerModel.withPricing(modelPlanRoute(info, service(), credentials()), [
    { input: model.inputPrice, output: model.outputPrice, cache: { read: model.inputPrice, write: model.inputPrice } },
  ])
  const before = gateway.seen.length
  const result = await stream(route)
  if (result._tag !== "Success") throw result.failure
  const events = [...result.success]
  expect(
    events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
  ).toBe("Reading the file.")
  expect(events.find((event) => event.type === "tool-call")).toMatchObject({
    name: "read",
    input: { path: "src/a.ts" },
  })
  const finish = events.find((event) => event.type === "step-finish")
  if (finish?.type !== "step-finish") throw new Error("Expected a step finish")
  expect(finish.reason).toBe("tool-calls")
  const tokens = { input: 1000, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }
  // The ceiling price would be 0.00022; the gateway reported what the provider actually billed.
  expect(SessionRunnerModel.calculateCost(route, tokens, finish.usage?.providerMetadata)).toBe(0.00042)
  const sent = gateway.seen.slice(before)
  expect(sent.map((item) => item.path)).toEqual(["/api/model-plans/chat"])
  expect(sent[0].authorization).toBe(`Bearer ${token}`)
  expect(sent[0].body).toMatchObject({ model: model.id, stream: true, stream_options: { include_usage: true } })
})

test("out of credits, plans disabled and an over-long context fail the turn at once without retrying", async () => {
  for (const [mode, tag, message] of [
    [
      "credits",
      "QuotaExceeded",
      `Your included model credits are used up. They renew at the next billing period. Buy credits at ${ModelPlans.PURCHASE_URL}`,
    ],
    ["disabled", "InvalidRequest", "Vector Codium is not available yet. Choose another model."],
    ["context", "InvalidRequest", "This conversation is too long for the Codium model. Compact it before continuing."],
  ] as const) {
    gateway.state.mode = mode
    const before = gateway.seen.length
    const result = await stream(modelPlanRoute(info, service(), credentials()))
    if (result._tag !== "Failure") throw new Error(`Expected ${mode} to fail`)
    const failure = result.failure
    if (!(failure instanceof LLMError)) throw failure
    expect(failure.reason._tag).toBe(tag)
    expect(failure.reason).toMatchObject({ message })
    expect(failure.reason.retryable).toBe(false)
    if (mode === "context") expect(failure.reason).toMatchObject({ classification: "context-overflow" })
    // Exactly one request: never retried, and never sent anywhere else.
    expect(gateway.seen.slice(before).map((item) => item.path)).toEqual(["/api/model-plans/chat"])
    expect(JSON.stringify(failure)).not.toContain(token)
  }
  gateway.state.mode = "ok"
})

test("plan requests reject invalid response limits and excessive UTF-8 context", () => {
  expect(() => ModelPlans.serializeRequest({ messages: [{}], max_tokens: -1 }, model)).toThrow("response length")
  expect(() =>
    ModelPlans.serializeRequest({ messages: [{ role: "user", content: "é".repeat(2_250_000) }] }, model),
  ).toThrow("Context too large")
})

test("gateway answers map to the action that fixes them", () => {
  const body = (code: string, message = "Server message.") => JSON.stringify({ error: { code, message } })
  expect(ModelPlans.gatewayFailure(402, body("MODEL_PLAN_REQUIRED"))).toEqual({
    code: "MODEL_PLAN_REQUIRED",
    kind: "credits",
    message: `Server message. Buy credits at ${ModelPlans.PURCHASE_URL}`,
  })
  expect(ModelPlans.gatewayFailure(402, "not json")?.kind).toBe("credits")
  expect(ModelPlans.gatewayFailure(401, body("CLI_TOKEN_INVALID"))).toMatchObject({ kind: "sign-in" })
  expect(ModelPlans.gatewayFailure(503, body("MODEL_PLANS_DISABLED"))).toMatchObject({ kind: "unavailable" })
  expect(ModelPlans.gatewayFailure(409, body("MODEL_PLAN_ACCOUNT_CLOSING"))).toMatchObject({ kind: "unavailable" })
  // Transient capacity is left to the normal retry policy.
  expect(ModelPlans.gatewayFailure(429, body("MODEL_PLAN_BUSY"))).toBeUndefined()
  expect(ModelPlans.gatewayFailure(503, body("MODEL_PLAN_UPSTREAM"))).toBeUndefined()
  expect(ModelPlans.contextFailure(body("MODEL_PLAN_CONTEXT"))).toBe(true)
  expect(ModelPlans.usageCost({ usage: { cost: 0.5 } })).toBe(0.5)
  expect(ModelPlans.usageCost({ usage: { cost: -1 } })).toBeUndefined()
  expect(ModelPlans.usageCost({ choices: [] })).toBeUndefined()
})

test("status reads plan and balances in Codium credits and flags a low balance", async () => {
  const before = gateway.seen.length
  const status = await ModelPlanStatus.fetchStatus(token, gateway.forward)
  expect(gateway.seen.slice(before)).toEqual([
    { path: "/api/model-plans/status", authorization: `Bearer ${token}`, body: undefined },
  ])
  expect(status).toEqual({
    signedIn: true,
    enabled: true,
    access: true,
    plan: {
      id: "vector-20",
      name: "Codium 20",
      credits: 1600,
      remaining: 120,
      renewsAt: 1_790_000_000_000,
      cancelAtPeriodEnd: false,
    },
    purchased: { credits: 800, remaining: 10 },
    remaining: 130,
    low: true,
  })
  expect(ModelPlanStatus.describe(status)).toEqual([
    `Plan: Codium 20, 120 of 1,600 monthly credits left, renews ${ModelPlanStatus.formatDate(1_790_000_000_000)}`,
    "Purchased credits: 10 of 800 left",
    "You are running low on Codium credits.",
  ])
  expect(JSON.stringify(status)).not.toContain(token)
})

test("status without credits, signed out, expired or unreachable says what to do", async () => {
  const saved = gateway.state.status
  gateway.state.status = {
    enabled: true,
    active: false,
    access: false,
    customer: true,
    wallet: { credits: 0, used: 0, remaining: 0 },
  }
  const empty = await ModelPlanStatus.fetchStatus(token, gateway.forward)
  expect(empty).toMatchObject({ signedIn: true, access: false, plan: undefined, remaining: 0, low: false })
  expect(ModelPlanStatus.describe(empty).at(-1)).toBe(
    "You have no Codium credits available. Buy credits to use Codium models.",
  )
  gateway.state.status = { enabled: false, active: false, access: false, wallet: { credits: 0, used: 0, remaining: 0 } }
  expect(ModelPlanStatus.describe(await ModelPlanStatus.fetchStatus(token, gateway.forward)).at(-1)).toBe(
    "Vector Codium is not available yet.",
  )
  gateway.state.status = saved

  const before = gateway.seen.length
  expect(await ModelPlanStatus.fetchStatus(undefined, gateway.forward)).toMatchObject({ signedIn: false })
  expect(gateway.seen.length).toBe(before)
  expect(await ModelPlanStatus.fetchStatus("vct_expired.token", gateway.forward)).toMatchObject({
    signedIn: false,
    error: "Your Vector sign-in expired. Sign in again.",
  })
  expect(await ModelPlanStatus.fetchStatus(token, () => Promise.reject(new Error("offline")))).toMatchObject({
    signedIn: true,
    error: "Vector could not load your Codium balance. Try again shortly.",
  })
})

test("the app recognises a failed Codium turn from the engine's recorded error", () => {
  expect(
    ModelPlanStatus.failureAction({ name: "APIError", data: { message: "x", metadata: { codium: "credits" } } }),
  ).toBe("credits")
  expect(ModelPlanStatus.failureAction({ name: "APIError", data: { message: "x", metadata: { url: "u" } } })).toBe(
    undefined,
  )
  expect(ModelPlanStatus.failureAction({ name: "UnknownError", data: { metadata: { codium: "credits" } } })).toBe(
    undefined,
  )
})
