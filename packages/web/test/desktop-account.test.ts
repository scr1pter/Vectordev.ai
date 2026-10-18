import { afterAll, beforeAll, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import codeHandler from "../../../api/account/cli-code"
import exchangeHandler from "../../../api/account/cli-exchange"
import deleteHandler from "../../../api/account/delete"
import { verifyCliToken, verifyDeletionGrant, verifyDesktopToken } from "../../../api/_lib/cli-token"
import {
  deletionConfirmation,
  desktopSignInCallback,
  desktopSignInRequest,
  signedInRecently,
} from "../src/lib/desktop-sign-in"
import { createVectorAccount } from "../../desktop/src/main/vector-account"

const records = new Map<string, string>()
const counts = new Map<string, number>()
const state = { unavailable: false, revoked: false, origin: "", identityDeletions: 0 }
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "fixture@example.test",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  user_metadata: { full_name: "  Fixture Person  ", avatar_url: "https://lh3.googleusercontent.com/a/fixture=s96-c" },
}
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    // Account deletion: revoking the account's tokens, erasing usage and deleting the identity.
    if (path.startsWith("/set/")) return Response.json({ result: "OK" })
    if (path.startsWith("/rest/v1/rpc/")) return Response.json(null)
    if (path.startsWith("/auth/v1/admin/users/") && request.method === "DELETE") {
      state.identityDeletions++
      return Response.json({})
    }
    if (path === "/auth/v1/user")
      return request.headers.get("authorization") === "Bearer synthetic-session" ||
        request.headers.get("authorization")?.startsWith("Bearer synthetic.")
        ? Response.json(user)
        : new Response(null, { status: 401 })
    if (state.unavailable) return new Response(null, { status: 503 })
    const parts = (await request.json()) as string[]
    const grantKey = parts[1]?.startsWith("vector:deletion-grant:")
    if (parts[0] === "GET")
      return Response.json({ result: grantKey ? (records.get(parts[1]) ?? null) : state.revoked ? "1" : null })
    if (parts[0] === "SET") {
      records.set(parts[1], parts[2])
      // A used deletion grant is kept a little longer than it lasts; a sign-in code for its five minutes.
      expect(parts.slice(3)).toEqual(["EX", grantKey ? "900" : "300", "NX"])
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
  if (request.url === "/delete") return void deleteHandler(request, response)
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
// A browser session's access token as Supabase issues it, carrying when its sign-in happened. Supabase verifies the
// signature; the fixture accepts any token of this shape.
function session(signedInAt: number) {
  const claims = Buffer.from(
    JSON.stringify({ amr: [{ method: "password", timestamp: Math.floor(signedInAt / 1000) }] }),
  )
  return `synthetic.${claims.toString("base64url")}.signature`
}
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
  // The desktop shows this name and photo in its sidebar; neither enters the token.
  expect(exchanged.user).toEqual({
    id: user.id,
    email: user.email,
    name: "Fixture Person",
    avatar: "https://lh3.googleusercontent.com/a/fixture=s96-c",
  })
  expect(Buffer.from(exchanged.token.slice(4).split(".")[0], "base64url").toString()).not.toContain("googleusercontent")
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
      if (url === user.user_metadata.avatar_url)
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "content-type": "image/jpeg" } })
      expect(url).toBe("https://vectordev.ai/api/account/cli-exchange")
      return fetch(`${state.origin}/exchange`, init)
    },
    sync: async (token) => {
      desktop.token = token ?? ""
    },
    changed: (value) => {
      desktop.states.push(value)
    },
    billingWindow: async () => "closed",
    focusBilling: () => undefined,
  })
  await account.start()
  const login = desktopSignInRequest(new URL(desktop.url).search)!
  const response = await request("/code", login)
  expect(response.status).toBe(200)
  const callback = desktopSignInCallback(await response.json(), login.state)
  expect(await account.consume([callback])).toEqual([])
  expect(account.status()).toMatchObject({
    authenticated: true,
    pending: false,
    email: user.email,
    name: "Fixture Person",
    avatar: "data:image/jpeg;base64,/9j/4A==",
  })
  expect(verifyCliToken(desktop.token)).toEqual({ id: user.id, email: user.email })
  expect(JSON.stringify([desktop.url, callback, desktop.stored, desktop.states])).not.toContain(desktop.token)
})

test("a code for deleting the account needs a sign-in from the last ten minutes and buys only a deletion grant", async () => {
  const input = binding()
  const stale = await request(
    "/code",
    { ...input, purpose: "delete" },
    { authorization: `Bearer ${session(Date.now() - 11 * 60_000)}` },
  )
  expect(stale.status).toBe(401)
  expect(await stale.json()).toMatchObject({ error: { code: "RECENT_SIGN_IN_REQUIRED" } })
  // A session without a sign-in time is no more recent than an old one.
  expect((await request("/code", { ...input, purpose: "delete" })).status).toBe(401)
  expect((await request("/code", { ...input, purpose: "rename" })).status).toBe(400)

  const minted = await request(
    "/code",
    { ...input, purpose: "delete" },
    { authorization: `Bearer ${session(Date.now() - 60_000)}` },
  )
  expect(minted.status).toBe(200)
  const code = await minted.json()
  const exchanged = await request("/exchange", { ...input, code: code.code })
  expect(exchanged.status).toBe(200)
  const body = await exchanged.json()
  expect(body.token).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain("vct_")
  expect(body.user).toEqual({ email: user.email })
  expect(verifyDeletionGrant(body.grant)).toMatchObject({ id: user.id, email: user.email, expiresAt: body.expiresAt })
  expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(600_000)
  expect(() => verifyCliToken(body.grant)).toThrow()

  // A sign-in code made without a purpose still buys a CLI token, as before.
  const normal = binding()
  const signIn = await (await request("/code", normal)).json()
  const token = (await (await request("/exchange", { ...normal, code: signIn.code })).json()).token
  expect(verifyCliToken(token)).toEqual({ id: user.id, email: user.email })
  // The desktop's own sign-in is marked as such, so it alone opens the billing portal.
  expect(verifyDesktopToken(token)).toEqual({ id: user.id, email: user.email })
})

test("the deletion confirmation keeps its purpose through sign-in and asks again after five minutes", () => {
  const input = binding()
  const query = new URLSearchParams({
    desktop: "1",
    purpose: "delete",
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  })
  const parsed = desktopSignInRequest(query.toString())!
  expect(parsed.purpose).toBe("delete")
  expect(parsed.returnPath).toContain("purpose=delete")
  expect(desktopSignInRequest(new URL(parsed.returnPath, "https://vectordev.ai").search)).toEqual(parsed)
  const renamed = new URLSearchParams({ ...Object.fromEntries(query), purpose: "rename" })
  expect(() => desktopSignInRequest(renamed.toString())).toThrow("Start sign-in")
  expect(signedInRecently(session(Date.now() - 60_000))).toBe(true)
  expect(signedInRecently(session(Date.now() - 6 * 60_000))).toBe(false)
  expect(signedInRecently("not-a-token")).toBe(false)
  expect(signedInRecently("a.%%%.b")).toBe(false)
  // Nothing is sent, and nobody is signed out, until the person chooses Continue on the page.
  expect(deletionConfirmation(false, session(Date.now() - 60_000))).toBe("ask")
  expect(deletionConfirmation(false, session(Date.now() - 60 * 60_000))).toBe("ask")
  expect(deletionConfirmation(true, session(Date.now() - 60_000))).toBe("confirm")
  expect(deletionConfirmation(true, session(Date.now() - 6 * 60_000))).toBe("sign-in-again")
})

test("deleting from the desktop runs through the browser's fresh sign-in and ends with the account gone", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role"
  // Earlier tests used up the sign-in rate limits.
  counts.clear()
  const desktop = {
    stored: undefined as unknown,
    url: "",
    token: undefined as string | undefined,
    states: [] as unknown[],
  }
  const routes: Record<string, string> = {
    "https://vectordev.ai/api/account/cli-exchange": "/exchange",
    "https://vectordev.ai/api/account/delete": "/delete",
  }
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
    decrypt: async () => "synthetic-token",
    openBrowser: async (url) => {
      desktop.url = url
    },
    fetch: async (url, init) => {
      if (url === user.user_metadata.avatar_url) return new Response(null, { status: 404 })
      expect(Object.keys(routes)).toContain(url)
      return fetch(state.origin + routes[url], init)
    },
    sync: async (token) => {
      desktop.token = token
    },
    changed: (value) => {
      desktop.states.push(value)
    },
    billingWindow: async () => "closed",
    focusBilling: () => undefined,
  })
  // Signed in to the app as the fixture account.
  await account.start()
  const login = desktopSignInRequest(new URL(desktop.url).search)!
  await account.consume([desktopSignInCallback(await (await request("/code", login)).json(), login.state)])
  expect(account.status()).toMatchObject({ authenticated: true, email: user.email })

  // The browser page confirms with a sign-in from a minute ago.
  await account.confirmDeletion()
  const confirm = desktopSignInRequest(new URL(desktop.url).search)!
  expect(confirm.purpose).toBe("delete")
  const minted = await request(
    "/code",
    { state: confirm.state, challenge: confirm.challenge, purpose: confirm.purpose },
    { authorization: `Bearer ${session(Date.now() - 60_000)}` },
  )
  expect(minted.status).toBe(200)
  await account.consume([desktopSignInCallback(await minted.json(), confirm.state)])
  expect(account.status()).toMatchObject({ authenticated: true, deletion: "confirmed" })
  expect(JSON.stringify([desktop.stored, desktop.states])).not.toContain("vdg_")

  expect(await account.deleteAccount(user.email)).toEqual({ deleted: true })
  expect(state.identityDeletions).toBe(1)
  // vectordev.ai recorded the grant as used, so it cannot delete again.
  expect([...records.keys()].filter((key) => key.startsWith("vector:deletion-grant:"))).toHaveLength(1)
  expect(account.status()).toEqual({ authenticated: false, pending: false })
  expect(desktop.stored).toBeUndefined()
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
})
