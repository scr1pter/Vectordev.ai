import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import codeHandler from "../../../api/account/cli-code"
import exchangeHandler from "../../../api/account/cli-exchange"
import { verifyCliToken } from "../../../api/_lib/cli-token"
import { desktopSignInCallback, desktopSignInRequest } from "../src/lib/desktop-sign-in"
import { createVectorAccount } from "../../desktop/src/main/vector-account"

const records = new Map<string, string>()
const counts = new Map<string, number>()
const state = { unavailable: false, revoked: false, origin: "" }
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "fixture@example.test",
  email_confirmed_at: "2026-01-01T00:00:00Z",
}
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/auth/v1/user")
      return request.headers.get("authorization") === "Bearer synthetic-session"
        ? Response.json(user)
        : new Response(null, { status: 401 })
    if (state.unavailable) return new Response(null, { status: 503 })
    const parts = (await request.json()) as string[]
    if (parts[0] === "GET") return Response.json({ result: state.revoked ? "1" : null })
    if (parts[0] === "SET") {
      records.set(parts[1], parts[2])
      expect(parts.slice(3)).toEqual(["EX", "300", "NX"])
      return Response.json({ result: "OK" })
    }
    if (parts[0] !== "EVAL") throw new Error("Unexpected fixture command")
    if (parts[1].includes("'INCR'")) {
      const count = (counts.get(parts[3]) ?? 0) + 1
      counts.set(parts[3], count)
      return Response.json({ result: [count, 300] })
    }
    const raw = records.get(parts[3])
    if (!raw) return Response.json({ result: null })
    const record = JSON.parse(raw)
    if (record.state !== parts[4] || record.challenge !== parts[5] || record.expiresAt <= Number(parts[6]))
      return Response.json({ result: null })
    records.delete(parts[3])
    return Response.json({ result: raw })
  },
})
const server = createServer((request, response) => {
  void (request.url === "/code" ? codeHandler(request, response) : exchangeHandler(request, response))
})

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "development",
    KV_REST_API_URL: upstream.url.origin,
    KV_REST_API_TOKEN: "synthetic-kv",
    VECTOR_CLI_TOKEN_SECRET: "synthetic-token-secret".repeat(3),
    VECTOR_ABUSE_SECRET: "synthetic-abuse-secret".repeat(3),
    SUPABASE_URL: upstream.url.origin,
    SUPABASE_PUBLISHABLE_KEY: "synthetic-public",
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  state.origin = `http://127.0.0.1:${address.port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
  upstream.stop(true)
  for (const key of [
    "NODE_ENV",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "VECTOR_CLI_TOKEN_SECRET",
    "VECTOR_ABUSE_SECRET",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
  ])
    delete process.env[key]
})
const request = (route: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(state.origin + route, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-session", ...extra },
    body: JSON.stringify(body),
  })
function binding() {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    state: randomBytes(32).toString("base64url"),
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

test("desktop sign-in requires a real authenticated session and rejects unsafe inputs", async () => {
  expect((await request("/code", binding(), { authorization: "Bearer invalid" })).status).toBe(401)
  expect((await request("/code", binding(), { origin: "https://foreign.example" })).status).toBe(403)
  expect((await request("/code", { state: "invalid", challenge: "invalid" })).status).toBe(400)
  expect((await request("/code", { padding: "a".repeat(2_100) })).status).toBe(413)
})

test("PKCE and state bind one code to one desktop and concurrent replay has only one winner", async () => {
  const input = binding()
  const minted = await request("/code", input)
  expect(minted.status).toBe(200)
  expect(minted.headers.get("cache-control")).toBe("no-store")
  const code = await minted.json()
  expect(code.token).toBeUndefined()
  expect(code.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(code.expiresAt - Date.now()).toBeLessThanOrEqual(300_000)
  expect(
    (await request("/exchange", { ...input, code: code.code, state: randomBytes(32).toString("base64url") })).status,
  ).toBe(400)
  expect(
    (await request("/exchange", { ...input, code: code.code, verifier: randomBytes(32).toString("base64url") })).status,
  ).toBe(400)
  const responses = await Promise.all([
    request("/exchange", { ...input, code: code.code }),
    request("/exchange", { ...input, code: code.code }),
  ])
  expect(responses.map((item) => item.status).sort()).toEqual([200, 400])
  const success = responses.find((item) => item.status === 200)!
  const exchanged = await success.json()
  expect(verifyCliToken(exchanged.token)).toEqual({ id: user.id, email: user.email })
  const callback = desktopSignInCallback(code, input.state)
  expect(callback).toStartWith("vector://auth/callback?")
  expect(callback).not.toContain(exchanged.token)
  expect(callback).not.toContain("vct_")
})

test("expired codes, unavailable KV and attempt exhaustion fail closed even in development", async () => {
  const input = binding()
  const minted = await (await request("/code", input)).json()
  for (const [key, raw] of records) {
    const value = JSON.parse(raw)
    if (value.state === input.state) records.set(key, JSON.stringify({ ...value, expiresAt: 0 }))
  }
  expect((await request("/exchange", { ...input, code: minted.code })).status).toBe(400)
  state.unavailable = true
  expect((await request("/code", input)).status).toBe(503)
  expect((await request("/exchange", { ...input, code: minted.code })).status).toBe(503)
  state.unavailable = false
  for (const attempt of Array.from({ length: 8 }, (_, index) => index)) {
    const result = await request("/exchange", { ...input, code: minted.code })
    expect(result.status).toBe(attempt < 7 ? 400 : 429)
  }
})

test("account revocation blocks both new codes and an already minted desktop grant", async () => {
  const input = binding()
  const minted = await (await request("/code", input)).json()
  state.revoked = true
  expect((await request("/code", input)).status).toBe(401)
  expect((await request("/exchange", { ...input, code: minted.code })).status).toBe(401)
  state.revoked = false
  expect((await request("/exchange", { ...input, code: minted.code })).status).toBe(400)
})

test("login return paths retain only validated desktop binding fields", () => {
  const input = binding()
  const query = new URLSearchParams({
    desktop: "1",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    returnTo: "https://foreign.example",
  })
  const parsed = desktopSignInRequest(query.toString())!
  expect(parsed.returnPath).toStartWith("/auth/cli?")
  expect(parsed.returnPath).not.toContain("foreign")
  expect(desktopSignInRequest(new URL(parsed.returnPath, "https://vectordev.ai").search)).toEqual(parsed)
  expect(() => desktopSignInRequest("desktop=1&state=bad")).toThrow("Start sign-in")
  expect(() => desktopSignInCallback({ code: "vct_private", state: input.state }, input.state)).toThrow()
})

test("desktop start, signed-in website and one-time API exchange complete the same bound flow", async () => {
  const desktop = { stored: undefined as unknown, url: "", token: "", states: [] as unknown[] }
  const account = createVectorAccount({
    read: () => desktop.stored,
    write: (value) => {
      desktop.stored = value
    },
    clear: async () => {
      desktop.stored = undefined
    },
    available: async () => true,
    encrypt: async () => "synthetic-ciphertext",
    decrypt: async () => {
      throw new Error("Not used by the new sign-in fixture")
    },
    openBrowser: async (url) => {
      desktop.url = url
    },
    fetch: async (url, init) => {
      expect(url).toBe("https://vectordev.ai/api/account/cli-exchange")
      return fetch(`${state.origin}/exchange`, init)
    },
    sync: async (token) => {
      desktop.token = token ?? ""
    },
    changed: (value) => {
      desktop.states.push(value)
    },
  })
  await account.start()
  const login = desktopSignInRequest(new URL(desktop.url).search)!
  const response = await request("/code", login)
  expect(response.status).toBe(200)
  const callback = desktopSignInCallback(await response.json(), login.state)
  expect(await account.consume([callback])).toEqual([])
  expect(account.status()).toMatchObject({ authenticated: true, pending: false, email: user.email })
  expect(verifyCliToken(desktop.token)).toEqual({ id: user.id, email: user.email })
  expect(JSON.stringify([desktop.url, callback, desktop.stored, desktop.states])).not.toContain(desktop.token)
})
