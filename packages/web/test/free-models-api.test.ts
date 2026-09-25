import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createServer, request } from "node:http"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RedisClient } from "bun"
import { createHash, randomBytes } from "node:crypto"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { mintDesktopCode, consumeDesktopCode } from "../../../api/_lib/desktop-account"
import {
  currentFreeModelCatalog,
  FREE_MODELS_CATALOG_KEY,
  refreshFreeModelCatalog,
} from "../../../api/_lib/free-models-catalog"
import { handleFreeModelsChat } from "../../../api/_lib/free-models-chat"
import modelsHandler from "../../../api/free-models/models"
import refreshHandler from "../../../api/free-models/refresh"
import type { FreeModelInfo } from "../../schema/src/free-model"

// This integration suite executes the production Lua against real Redis/Valkey.
// CI may supply VECTOR_TEST_REDIS_URL; local runs supply the two executable paths.
const temporary = await mkdtemp(path.join(os.tmpdir(), "vector-free-models-"))
const socket = path.join(temporary, "db.sock")
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

const model = (id: string, provider = "Cohere") => ({
  id,
  name: id.replace(":free", " (free)"),
  context_length: 8192,
  pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["tools", "tool_choice"],
  top_provider: { max_completion_tokens: 2048 },
  provider,
})
const candidates = [
  model("cohere/fixture:free"),
  model("poolside/fixture:free", "Poolside"),
  model("qwen/fixture:free", "ModelRun"),
]
const catalogModels: FreeModelInfo[] = candidates.map((item) => ({
  id: item.id,
  name: item.name,
  contextLength: 8192,
  maxOutputTokens: 2048,
  providers: [{ id: item.provider.toLowerCase(), name: item.provider, retention: "Fixture only" }],
}))
const state = {
  origin: "",
  unavailable: false,
  remaining: 50,
  upstreamStatus: 200,
  streamError: 0,
  truncated: false,
  delayed: false,
  keyInvalid: false,
  keyCalls: 0,
  models: [...candidates],
  training: false,
  userModels: candidates.map((item) => item.id),
}
const chats: { headers: Headers; body: Record<string, unknown> }[] = []
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
      return Response.json({ result: await redis(command) })
    }
    if (url.pathname === "/api/v1/models") return Response.json({ data: state.models })
    if (url.pathname === "/api/v1/models/user") {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-openrouter-key")
      return Response.json({ data: state.userModels.map((id) => ({ id })) })
    }
    if (url.pathname === "/api/frontend/all-providers")
      return Response.json({
        data: ["Cohere", "Poolside", "ModelRun"].map((name) => ({
          name,
          slug: name.toLowerCase(),
          displayName: name,
          dataPolicy: { training: state.training, trainingOpenRouter: false, retainsPrompts: false, canPublish: false },
        })),
      })
    if (url.pathname.endsWith("/endpoints")) {
      const id = decodeURIComponent(url.pathname.slice("/api/v1/models/".length, -"/endpoints".length))
      const found = state.models.find((item) => item.id === id)
      if (!found) throw new Error("Unknown fixture model")
      return Response.json({
        data: {
          endpoints: [
            {
              provider_name: found.provider,
              tag: found.provider.toLowerCase(),
              context_length: 8192,
              max_completion_tokens: 2048,
              pricing: found.pricing,
              supported_parameters: found.supported_parameters,
              status: 0,
            },
          ],
        },
      })
    }
    if (url.pathname === "/api/v1/key") {
      state.keyCalls++
      return Response.json({
        data: state.keyInvalid
          ? {}
          : { free_model_daily_requests: { used: 50 - state.remaining, limit: 50, remaining: state.remaining } },
      })
    }
    if (url.pathname === "/api/v1/chat/completions") {
      const body = (await request.json()) as Record<string, unknown>
      chats.push({ headers: new Headers(request.headers), body })
      if (state.upstreamStatus !== 200)
        return Response.json(
          { error: { message: "Do not leak fixture-openrouter-key" } },
          { status: state.upstreamStatus, headers: { "retry-after": "30" } },
        )
      const error = state.streamError
      const truncated = state.truncated
      const delayed = state.delayed
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"fixture"}}]}\r'))
            if (delayed) await Bun.sleep(150)
            controller.enqueue(encoder.encode("\n\r\n"))
            if (error)
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ error: { code: error, message: "Do not leak fixture-openrouter-key" } })}\n\n`,
                ),
              )
            if (!truncated) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    throw new Error(`Unexpected fixture request ${url.pathname}`)
  },
})
const fetcher: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.origin === "https://openrouter.ai") return fetch(new URL(url.pathname + url.search, upstream.url), init)
    if (url.origin === upstream.url.origin) return fetch(input, init)
    throw new Error(`Unexpected network destination ${url.origin}`)
  },
  { preconnect: fetch.preconnect },
)
const server = createServer((request, response) => {
  if (request.url === "/models") {
    void modelsHandler(request, response)
    return
  }
  if (request.url === "/refresh") {
    void refreshHandler(request, response)
    return
  }
  void handleFreeModelsChat(request, response, fetcher)
})

beforeAll(async () => {
  if (!database) {
    for (let count = 0; count < 300 && !(await stat(socket).catch(() => undefined)); count++) await Bun.sleep(10)
  }
  expect(await redis(["PING"])).toBe("PONG")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing server address")
  state.origin = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  await redis(["FLUSHDB"])
  Object.assign(process.env, {
    NODE_ENV: "development",
    FREE_MODELS_ENABLED: "true",
    FREE_MODELS_DAILY_PER_USER: "20",
    FREE_MODELS_MINUTE_PER_USER: "4",
    VECTOR_CLI_TOKEN_SECRET: "fixture-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
    KV_REST_API_URL: new URL("/redis", upstream.url).href,
    KV_REST_API_TOKEN: "fixture-kv-token",
    OPENROUTER_API_KEY: "fixture-openrouter-key",
  })
  delete process.env.VERCEL_ENV
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  Object.assign(state, {
    unavailable: false,
    remaining: 50,
    upstreamStatus: 200,
    streamError: 0,
    truncated: false,
    delayed: false,
    keyInvalid: false,
    keyCalls: 0,
    models: [...candidates],
    training: false,
    userModels: candidates.map((item) => item.id),
  })
  chats.length = 0
  await redis([
    "SET",
    FREE_MODELS_CATALOG_KEY,
    JSON.stringify({ enabled: true, updatedAt: Date.now(), models: catalogModels }),
  ])
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
  for (const key of [
    "NODE_ENV",
    "FREE_MODELS_ENABLED",
    "FREE_MODELS_DAILY_PER_USER",
    "FREE_MODELS_MINUTE_PER_USER",
    "VECTOR_CLI_TOKEN_SECRET",
    "VECTOR_ABUSE_SECRET",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "OPENROUTER_API_KEY",
  ])
    delete process.env[key]
})

function account(id = "11111111-1111-4111-8111-111111111111") {
  return mintCliToken({ id, email: "fixture@example.test" }).token
}
async function chat(
  body: unknown = { model: candidates[0].id, messages: [{ role: "user", content: "fixture prompt" }] },
  token = account(),
  headers: Record<string, string> = {},
) {
  const response = await fetch(state.origin + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  })
  return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
}

describe("curated free catalog", () => {
  test("OFF returns an empty public catalog without a key or store", async () => {
    delete process.env.FREE_MODELS_ENABLED
    delete process.env.KV_REST_API_URL
    delete process.env.OPENROUTER_API_KEY
    expect(await (await fetch(state.origin + "/models")).json()).toEqual({ enabled: false, updatedAt: 0, models: [] })
    expect((await chat()).status).toBe(503)
    expect(chats).toHaveLength(0)
  })
  test("curates live prices, tools, expiry, endpoint policies and account availability into real KV", async () => {
    state.models.push(
      { ...model("cohere/paid:free"), pricing: { prompt: "1", completion: "0" } },
      model("google/training:free"),
      model("nvidia/trial:free"),
      model("liquid/training:free"),
      { ...model("cohere/no-tools:free"), supported_parameters: ["tools"] },
      { ...model("cohere/expired:free"), expiration_date: new Date(Date.now() + 86400000).toISOString() } as ReturnType<
        typeof model
      >,
    )
    state.userModels = state.models.map((item) => item.id).filter((id) => id !== candidates[2].id)
    const catalog = await refreshFreeModelCatalog(fetcher)
    expect(catalog.models.map((item) => item.id)).toEqual([candidates[0].id, candidates[1].id])
    expect(catalog.models.every((item) => !item.name.endsWith("(free)"))).toBe(true)
    expect(await currentFreeModelCatalog(fetcher)).toEqual(catalog)
    expect(Number(await redis(["TTL", FREE_MODELS_CATALOG_KEY]))).toBeGreaterThan(100000)
    state.training = true
    expect((await refreshFreeModelCatalog(fetcher)).models).toEqual([])
  })
  test("refuses stale catalogs and unauthenticated cron refreshes", async () => {
    await redis([
      "SET",
      FREE_MODELS_CATALOG_KEY,
      JSON.stringify({ enabled: true, updatedAt: 1, models: catalogModels }),
    ])
    expect((await fetch(state.origin + "/models")).status).toBe(503)
    expect((await fetch(state.origin + "/refresh")).status).toBe(401)
  })
  test("refuses corrupt cached routing metadata before inference", async () => {
    for (const change of [
      { providers: [] },
      { providers: [{ id: "unknown", name: "Unknown", retention: "Unknown" }] },
      { maxOutputTokens: -1 },
      { id: "cohere/paid" },
    ]) {
      await redis([
        "SET",
        FREE_MODELS_CATALOG_KEY,
        JSON.stringify({ enabled: true, updatedAt: Date.now(), models: [{ ...catalogModels[0], ...change }] }),
      ])
      expect((await chat()).status).toBe(503)
    }
    expect(chats).toHaveLength(0)
  })
})

test("real KV atomically consumes a PKCE-bound desktop grant once without burning mismatched bindings", async () => {
  const verifier = randomBytes(32).toString("base64url")
  const binding = {
    state: randomBytes(32).toString("base64url"),
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
  const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
  const grant = await mintDesktopCode(user, binding, fetcher)
  await expect(
    consumeDesktopCode({ ...grant, verifier: randomBytes(32).toString("base64url") }, fetcher),
  ).rejects.toThrow("expired or was already used")
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => consumeDesktopCode({ ...grant, verifier }, fetcher)),
  )
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(5)
  expect(results.find((result) => result.status === "fulfilled")).toEqual({ status: "fulfilled", value: user })
})

describe("shared free inference", () => {
  test("requires a Vector token and current nonrevoked account, and fails closed without persistent KV", async () => {
    expect((await chat(undefined, "invalid")).status).toBe(401)
    await redis(["SET", "vector:cli-revoked:11111111-1111-4111-8111-111111111111", "1"])
    expect((await chat()).status).toBe(401)
    await redis(["DEL", "vector:cli-revoked:11111111-1111-4111-8111-111111111111"])
    state.unavailable = true
    expect((await chat()).status).toBe(503)
    state.unavailable = false
    delete process.env.KV_REST_API_URL
    expect((await chat()).status).toBe(503)
    expect(chats).toHaveLength(0)
  })
  test("streams split CRLF frames, hashes the account, pins all routes to free prices and strips routing overrides", async () => {
    const response = await chat({
      model: candidates[0].id,
      messages: [{ role: "user", content: "fixture" }],
      provider: { data_collection: "allow" },
      models: ["paid/model"],
      user: "attacker",
      web_search_options: {},
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"content":"fixture"')
    expect(body).toContain("[DONE]")
    expect(chats).toHaveLength(1)
    expect(chats[0].headers.get("authorization")).toBe("Bearer fixture-openrouter-key")
    expect(chats[0].headers.get("http-referer")).toBe("https://vectordev.ai/")
    expect(chats[0].headers.get("x-openrouter-title")).toBe("Vector")
    expect(chats[0].body.models).toEqual(candidates.map((item) => item.id))
    expect(chats[0].body.provider).toEqual({
      data_collection: "deny",
      require_parameters: true,
      only: ["cohere", "poolside", "modelrun"],
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    })
    expect(chats[0].body.user).toMatch(/^[a-f0-9]{64}$/)
    expect(chats[0].body.web_search_options).toBeUndefined()
    expect(JSON.stringify(chats[0].body)).not.toContain("vct_")
  })
  test("rejects paid IDs, plugins, unsupported media, foreign origins and contexts above 4.5 MB before inference", async () => {
    expect((await chat({ model: "paid/model", messages: [{}] })).status).toBe(400)
    expect(
      (await chat({ model: candidates[0].id, messages: [{ role: "user", content: "x" }], plugins: [{ id: "web" }] }))
        .status,
    ).toBe(400)
    expect(
      (await chat({ model: candidates[0].id, messages: [{ role: "user", content: [{ type: "file", file: {} }] }] }))
        .status,
    ).toBe(400)
    expect((await chat(undefined, account(), { origin: "https://foreign.example" })).status).toBe(403)
    const large = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({
        model: candidates[0].id,
        messages: [{ role: "user", content: "x".repeat(4500000) }],
      })
      const incoming = request(
        state.origin + "/chat",
        {
          method: "POST",
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            authorization: `Bearer ${account()}`,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
          response.on("error", reject)
        },
      )
      incoming.on("error", reject)
      incoming.end(body)
    })
    expect(large.status).toBe(413)
    expect(large.body).toContain("4.5 MB")
    expect(chats).toHaveLength(0)
  })
  test("enforces atomic user caps with reset times", async () => {
    process.env.FREE_MODELS_DAILY_PER_USER = "2"
    process.env.FREE_MODELS_MINUTE_PER_USER = "20"
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        chat().then(async (response) => ({ status: response.status, body: await response.text() })),
      ),
    )
    expect(results.filter((result) => result.status === 200)).toHaveLength(2)
    expect(results.filter((result) => result.status === 429)).toHaveLength(3)
    expect(chats).toHaveLength(2)
    const error = JSON.parse(results.find((result) => result.status === 429)!.body).error
    expect(error).toMatchObject({ type: "free_models_limit", reason: "user_daily" })
    expect(error.resetAt).toBeGreaterThan(Date.now())
  })
  test("a minute-capped account makes no further upstream control-plane requests", async () => {
    process.env.FREE_MODELS_MINUTE_PER_USER = "1"
    expect((await chat()).status).toBe(200)
    for (const response of await Promise.all([chat(), chat(), chat()])) {
      expect(response.status).toBe(429)
      expect((await response.json()).error.reason).toBe("user_minute")
    }
    expect(state.keyCalls).toBe(1)
    expect(chats).toHaveLength(1)
  })
  test("the default allowance preserves fair access on an uncredited 50-request account", async () => {
    delete process.env.FREE_MODELS_DAILY_PER_USER
    process.env.FREE_MODELS_MINUTE_PER_USER = "20"
    for (const index of Array.from({ length: 6 }, (_, index) => index)) {
      const response = await chat()
      expect(response.status).toBe(index < 5 ? 200 : 429)
      if (index === 5) expect((await response.json()).error.reason).toBe("user_daily")
    }
    expect(chats).toHaveLength(5)
  })
  test("reserves the final global allowance atomically across different accounts", async () => {
    state.remaining = 1
    state.delayed = true
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        chat(undefined, account(`11111111-1111-4111-8111-${String(index).padStart(12, "0")}`)).then(
          async (response) => ({ status: response.status, body: await response.text() }),
        ),
      ),
    )
    expect(results.filter((result) => result.status === 200)).toHaveLength(1)
    expect(chats).toHaveLength(1)
  })
  test("global exhaustion and unknown upstream counters make no inference request", async () => {
    state.remaining = 0
    const limited = await chat()
    expect(limited.status).toBe(429)
    expect((await limited.json()).error.reason).toBe("shared_daily")
    state.remaining = 50
    state.keyInvalid = true
    expect((await chat()).status).toBe(503)
    expect(chats).toHaveLength(0)
  })
  for (const status of [402, 429])
    test(`normalizes upstream ${status} before and during streaming without secret leakage or retries`, async () => {
      state.upstreamStatus = status
      const before = await chat()
      expect(before.status).toBe(429)
      expect((await before.json()).error.type).toBe("free_models_limit")
      state.upstreamStatus = 200
      state.streamError = status
      const during = await chat()
      const body = await during.text()
      expect(body).toContain('"content":"fixture"')
      expect(body).toContain('"type":"free_models_limit"')
      expect(body).not.toContain("fixture-openrouter-key")
      expect(chats).toHaveLength(2)
    })
  test("treats a truncated stream as a recoverable failure", async () => {
    state.truncated = true
    expect(await (await chat()).text()).toContain("FREE_MODELS_STREAM_INVALID")
  })
})
