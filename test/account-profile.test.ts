import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import profileHandler from "../api/account/profile"
import { accountAvatar } from "../api/_lib/account"
import { mintCliToken } from "../api/_lib/cli-token"

const ID = "9db2bb31-81d5-43cb-b4a1-f1d3d799c9cb"
const PHOTO = "https://lh3.googleusercontent.com/a/fixture=s96-c"
const variables = [
  "NODE_ENV",
  "VERCEL_ENV",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "VECTOR_CLI_TOKEN_SECRET",
  "VECTOR_ABUSE_SECRET",
]
const original = Object.fromEntries(variables.map((key) => [key, process.env[key]]))
const state = {
  origin: "",
  revoked: false,
  status: 200,
  metadata: { full_name: "  Ada Lovelace  ", avatar_url: PHOTO } as Record<string, unknown>,
  admin: [] as Array<{ path: string; apikey: string | null; authorization: string | null }>,
}

// Supabase's admin API and the Redis REST store, as the endpoint reaches them.
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/auth/v1/admin/users/")) {
      state.admin.push({
        path: url.pathname,
        apikey: request.headers.get("apikey"),
        authorization: request.headers.get("authorization"),
      })
      if (state.status !== 200) return new Response(null, { status: state.status })
      return Response.json({ id: ID, email: "ada@example.test", user_metadata: state.metadata })
    }
    if (url.pathname.startsWith("/get/")) return Response.json({ result: state.revoked ? "1" : null })
    const parts = (await request.json()) as string[]
    if (parts[0] === "EVAL") return Response.json({ result: [1, 3600] })
    throw new Error("Unexpected fixture command")
  },
})
const server = createServer((request, response) => void profileHandler(request, response))

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  state.origin = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  variables.forEach((key) => delete process.env[key])
  Object.assign(process.env, {
    NODE_ENV: "development",
    SUPABASE_URL: upstream.url.origin,
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
    KV_REST_API_URL: upstream.url.origin,
    KV_REST_API_TOKEN: "fixture-kv",
    VECTOR_CLI_TOKEN_SECRET: "fixture-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "fixture-abuse-secret".repeat(3),
  })
  Object.assign(state, {
    revoked: false,
    status: 200,
    metadata: { full_name: "  Ada Lovelace  ", avatar_url: PHOTO },
    admin: [],
  })
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
  upstream.stop(true)
  Object.entries(original).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

const profile = (token = mintCliToken({ id: ID, email: "ada@example.test" }).token, method = "GET") =>
  fetch(`${state.origin}/api/account/profile`, { method, headers: { authorization: `Bearer ${token}` } })

test("a desktop's account token reads only its own name and photo, never the service key", async () => {
  const response = await profile()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = await response.text()
  expect(JSON.parse(body)).toEqual({ name: "Ada Lovelace", avatar: PHOTO })
  expect(body).not.toContain("fixture-service-role")
  expect(body).not.toContain("ada@example.test")
  expect(state.admin).toEqual([
    {
      path: `/auth/v1/admin/users/${ID}`,
      apikey: "fixture-service-role",
      authorization: "Bearer fixture-service-role",
    },
  ])
})

test("Google's picture field is used when avatar_url is missing, and missing values come back empty", async () => {
  state.metadata = { name: "Ada", picture: "https://lh5.googleusercontent.com/photo.jpg" }
  expect(await (await profile()).json()).toEqual({ name: "Ada", avatar: "https://lh5.googleusercontent.com/photo.jpg" })
  state.metadata = {}
  expect(await (await profile()).json()).toEqual({ name: null, avatar: null })
})

test("a photo outside Google's avatar hosts is left out rather than failing", async () => {
  for (const avatar of [
    "https://evil.example/photo.png",
    "http://lh3.googleusercontent.com/a/fixture",
    "https://lh3.googleusercontent.com.evil.example/a",
    "https://1.2.3.4.bc.googleusercontent.com/a",
    "https://user@lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com:8443/a",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    `https://lh3.googleusercontent.com/${"a".repeat(2_100)}`,
    42,
  ]) {
    state.metadata = { full_name: "Ada", avatar_url: avatar }
    expect(await (await profile()).json()).toEqual({ name: "Ada", avatar: null })
    expect(accountAvatar(avatar)).toBeUndefined()
  }
})

test("missing, forged, expired and revoked tokens are refused before Supabase is asked", async () => {
  expect((await profile("")).status).toBe(401)
  expect((await profile("vct_forged.signature")).status).toBe(401)
  expect(
    (await profile(mintCliToken({ id: ID, email: "ada@example.test" }, Date.now() - 91 * 86_400_000).token)).status,
  ).toBe(401)
  state.revoked = true
  expect((await profile()).status).toBe(401)
  expect(state.admin).toEqual([])
  state.revoked = false
  expect((await profile(undefined, "POST")).status).toBe(405)
})

test("a deleted account is signed out and an unavailable Supabase reports unavailable", async () => {
  state.status = 404
  expect((await profile()).status).toBe(401)
  state.status = 500
  expect((await profile()).status).toBe(503)
  state.status = 200
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  expect((await profile()).status).toBe(503)
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role"
  // Only a local development Supabase may be reached over plain http.
  process.env.NODE_ENV = "production"
  expect((await profile()).status).toBe(503)
})
