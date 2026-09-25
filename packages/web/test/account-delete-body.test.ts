import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import handler from "../../../api/account/delete"

const identity = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    expect(new URL(request.url).pathname).toBe("/auth/v1/user")
    expect(request.method).toBe("GET")
    return Response.json({
      id: "11111111-1111-4111-8111-111111111111",
      email: "fixture@example.test",
      email_confirmed_at: "2026-01-01T00:00:00Z",
    })
  },
})
const server = createServer((request, response) => void handler(request, response))
const state = { origin: "" }
const variables = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NODE_ENV",
  "VERCEL_ENV",
]

beforeAll(async () => {
  variables.forEach((key) => delete process.env[key])
  process.env.NODE_ENV = "development"
  process.env.SUPABASE_URL = identity.url.origin
  process.env.SUPABASE_PUBLISHABLE_KEY = "fixture-public-key"
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No fixture address")
  state.origin = `http://127.0.0.1:${address.port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
  identity.stop(true)
  variables.forEach((key) => delete process.env[key])
})

test("deletion reads the confirmation body and reaches no destructive step without admin configuration", async () => {
  for (const [confirm, status, code] of [
    ["another@example.test", 400, "CONFIRMATION_MISMATCH"],
    ["fixture@example.test", 503, "DELETION_NOT_CONFIGURED"],
  ] as const) {
    const response = await fetch(state.origin, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-session", "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    })
    expect(response.status).toBe(status)
    expect((await response.json()).error.code).toBe(code)
  }
})
