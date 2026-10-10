import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mintCliToken } from "../../../api/_lib/cli-token"
import { handleModelPlanStatus } from "../../../api/_lib/model-plan-status"

// The desktop app and CLI read Codium balances with their signed Vector account token; the website keeps its
// browser session. External services are local fakes reached through the injected fetcher.
const user = { id: "11111111-1111-4111-8111-111111111111", email: "fixture@example.test" }
const environment = {
  VECTOR_CLI_TOKEN_SECRET: "fixture-cli-token-secret-that-is-long-enough",
  KV_REST_API_URL: "https://kv.fixture.invalid",
  KV_REST_API_TOKEN: "fixture-kv-token",
  SUPABASE_URL: "https://auth.fixture.invalid",
  SUPABASE_PUBLISHABLE_KEY: "fixture-publishable",
  STRIPE_SECRET_KEY: "sk_test_fixture_placeholder",
  MODEL_PLANS_ENABLED: "true",
}
const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]))
const state = { revoked: false, calls: [] as string[] }
const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  state.calls.push(url)
  if (url === environment.KV_REST_API_URL) {
    const command = JSON.parse(String(init?.body)) as string[]
    if (command[1] === `vector:cli-revoked:${user.id}`) return Response.json({ result: state.revoked ? "1" : null })
    // No Codium billing account yet.
    return Response.json({ result: null })
  }
  if (url === `${environment.SUPABASE_URL}/auth/v1/user`) {
    if (new Headers(init?.headers).get("authorization") !== "Bearer browser-session")
      return new Response(null, { status: 401 })
    return Response.json({ ...user, email_confirmed_at: "2026-01-01T00:00:00Z" })
  }
  throw new Error(`Unexpected request to ${url}`)
}) as typeof fetch
const server = createServer((request, response) => void handleModelPlanStatus(request, response, fetcher))
const origin = { url: "" }

beforeAll(async () => {
  Object.assign(process.env, environment)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.close()
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const status = (token: string) =>
  fetch(`${origin.url}/api/model-plans/status`, { headers: { authorization: `Bearer ${token}` } })

test("a Vector account token reads Codium status, including whether Codium is on sale", async () => {
  const response = await status(mintCliToken(user).token)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    enabled: true,
    active: false,
    access: false,
    wallet: { credits: 0, used: 0, remaining: 0 },
  })
  // Verified locally and checked against revocation; Supabase is not involved.
  expect(state.calls.some((url) => url.startsWith(environment.SUPABASE_URL))).toBe(false)
})

test("revoked, forged and browser-session tokens each take the right path", async () => {
  state.revoked = true
  expect((await status(mintCliToken(user).token)).status).toBe(401)
  state.revoked = false
  expect((await status(`${mintCliToken(user).token}x`)).status).toBe(401)
  const browser = await status("browser-session")
  expect(browser.status).toBe(200)
  expect(await browser.json()).toMatchObject({ enabled: true, access: false })
  expect((await status("not-a-session")).status).toBe(401)
})

test("status reports Codium as off while sales are disabled", async () => {
  process.env.MODEL_PLANS_ENABLED = "false"
  expect(await (await status(mintCliToken(user).token)).json()).toMatchObject({ enabled: false, access: false })
  process.env.MODEL_PLANS_ENABLED = "true"
})
