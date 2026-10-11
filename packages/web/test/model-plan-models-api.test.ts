import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { CODIUM_MODELS } from "../../../api/_lib/codium-catalog"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { handleModelPlanModels } from "../../../api/_lib/model-plan-models"

// The catalog Vector polls about once a minute. Every signed-in account sees it while sales are on, with or without
// credits, and the read never reaches Stripe or OpenRouter. External services are local fakes behind the fetcher.
const user = { id: "22222222-2222-4222-8222-222222222222", email: "fixture@example.test" }
const environment: Record<string, string> = {
  VECTOR_CLI_TOKEN_SECRET: "fixture-cli-token-secret-that-is-long-enough",
  KV_REST_API_URL: "https://kv.fixture.invalid",
  KV_REST_API_TOKEN: "fixture-kv-token",
  MODEL_PLANS_ENABLED: "true",
  STRIPE_SECRET_KEY: "sk_test_fixture_placeholder",
  STRIPE_MODEL_PLAN_WEBHOOK_SECRET: "whsec_fixture_placeholder",
  STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture_placeholder",
  OPENROUTER_MANAGEMENT_KEY: "fixture-management-placeholder",
  MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
  ...Object.fromEntries(
    [10, 20, 50, 100, 200].map((price) => [`STRIPE_MODEL_PLAN_${price}_PRICE_ID`, `price_fixture${price}`]),
  ),
}
const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]))
const state = { revoked: false, calls: [] as string[] }
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  state.calls.push(url)
  if (url === environment.KV_REST_API_URL) {
    const command = JSON.parse(String(init?.body)) as string[]
    if (command[1] === `vector:cli-revoked:${user.id}`) return Response.json({ result: state.revoked ? "1" : null })
  }
  throw new Error(`Unexpected request to ${url}`)
}) as typeof fetch
const server = createServer((request, response) => void handleModelPlanModels(request, response, fetcher))
const origin = { url: "" }

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
beforeEach(() => {
  Object.assign(process.env, environment)
  state.revoked = false
  state.calls = []
})
afterAll(() => {
  server.close()
  for (const [key, value] of previous) {
    delete process.env[key]
    if (value !== undefined) process.env[key] = value
  }
})

const models = (token?: string) =>
  fetch(`${origin.url}/api/model-plans/models`, token ? { headers: { authorization: `Bearer ${token}` } } : {})

test("a signed-in account without credits sees the catalog, and only its revocation is checked", async () => {
  const response = await models(mintCliToken(user).token)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ enabled: true, models: CODIUM_MODELS })
  expect(state.calls).toEqual([environment.KV_REST_API_URL])
})

test("while sales are off the catalog is empty and nothing is checked, signed in or not", async () => {
  process.env.MODEL_PLANS_ENABLED = "false"
  for (const token of [mintCliToken(user).token, undefined]) {
    const response = await models(token)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false, models: [] })
  }
  expect(state.calls).toEqual([])
})

test("an incomplete server configuration answers that Codium is temporarily unavailable", async () => {
  delete process.env.OPENROUTER_MANAGEMENT_KEY
  const response = await models(mintCliToken(user).token)
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ error: { code: "MODEL_PLANS_CONFIGURATION" } })
})

test("revoked, forged and missing account tokens are refused", async () => {
  state.revoked = true
  expect((await models(mintCliToken(user).token)).status).toBe(401)
  state.revoked = false
  expect((await models(`${mintCliToken(user).token}x`)).status).toBe(401)
  expect((await models()).status).toBe(401)
})
