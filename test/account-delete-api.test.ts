import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import handler from "../api/account/delete"
import { accountTokensRevoked } from "../api/_lib/revocation"

const keys = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NODE_ENV",
  "VERCEL_ENV",
  "STRIPE_SECRET_KEY",
  "VECTOR_ACCESS_MODE",
] as const
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const servers: ReturnType<typeof createServer>[] = []
let endpoint = ""
let accountID = ""
let identityDeletions = 0
let revocationWrites = 0
let revocationAvailable = false

beforeEach(async () => {
  keys.forEach((key) => delete process.env[key])
  const id = crypto.randomUUID()
  accountID = id
  identityDeletions = 0
  revocationWrites = 0
  revocationAvailable = false
  const auth = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/" && request.method === "POST") {
      response.end(JSON.stringify({ result: [1, 60] }))
      return
    }
    if (request.url?.startsWith("/set/")) {
      revocationWrites++
      response.end(JSON.stringify(revocationAvailable ? { result: "OK" } : { error: "Redis write failed" }))
      return
    }
    if (request.url?.startsWith("/get/")) {
      response.end(JSON.stringify({ result: null }))
      return
    }
    if (request.method === "DELETE") {
      identityDeletions++
      response.end("{}")
      return
    }
    if (request.url !== "/auth/v1/user" || request.headers.authorization !== "Bearer test-session") {
      response.writeHead(401).end("{}")
      return
    }
    response.end(JSON.stringify({ id, email: "owner@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" }))
  })
  const api = createServer((request, response) => {
    void handler(request, response)
  })
  servers.push(auth, api)
  auth.listen(0, "127.0.0.1")
  api.listen(0, "127.0.0.1")
  await Promise.all([once(auth, "listening"), once(api, "listening")])
  const authAddress = auth.address()
  const apiAddress = api.address()
  if (!authAddress || typeof authAddress === "string" || !apiAddress || typeof apiAddress === "string")
    throw new Error("Missing test listeners")
  process.env.SUPABASE_URL = `http://127.0.0.1:${authAddress.port}`
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable"
  endpoint = `http://127.0.0.1:${apiAddress.port}`
})

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  keys.forEach((key) => {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

function attempt(confirm: string) {
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization: "Bearer test-session", "content-type": "application/json" },
    body: JSON.stringify({ confirm }),
  })
}

describe("account deletion request boundary", () => {
  test("reads the confirmation and stops before mutations without an admin key", async () => {
    const response = await attempt("owner@example.com")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "DELETION_NOT_CONFIGURED" } })
  })

  test("rejects the sixth attempt instead of swallowing the account rate limit", async () => {
    for (let index = 0; index < 5; index++) {
      const response = await attempt("wrong@example.com")
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: "CONFIRMATION_MISMATCH" } })
    }
    const response = await attempt("wrong@example.com")
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } })
  })

  test("retains the account when Redis cannot durably revoke its tokens", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
    process.env.KV_REST_API_URL = process.env.SUPABASE_URL
    process.env.KV_REST_API_TOKEN = "test-redis-token"
    const response = await attempt("owner@example.com")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "REVOCATION_FAILED" } })
    expect(revocationWrites).toBe(1)
    expect(identityDeletions).toBe(0)
    // A recovered Redis read with no key is valid only because the account
    // still exists; it must not resurrect tokens for a deleted identity.
    expect(await accountTokensRevoked(accountID)).toBe(false)
  })

  test("retains the account when paid billing cleanup is unavailable", async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role"
    process.env.KV_REST_API_URL = process.env.SUPABASE_URL
    process.env.KV_REST_API_TOKEN = "test-redis-token"
    process.env.VECTOR_ACCESS_MODE = "paid"
    revocationAvailable = true
    const response = await attempt("owner@example.com")
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "BILLING_DELETION_FAILED" } })
    expect(revocationWrites).toBe(1)
    expect(identityDeletions).toBe(0)
  })
})
