import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { createVectorAccount, syncVectorAccount } from "./vector-account"

function fixture() {
  const state = {
    stored: undefined as unknown,
    secure: true,
    now: 1_000,
    failStorage: false,
    fetchDelay: undefined as Promise<void> | undefined,
    syncDelay: undefined as Promise<void> | undefined,
    failSync: false,
  }
  const urls: string[] = []
  const tokens: Array<string | undefined> = []
  const statuses: unknown[] = []
  const requests: RequestInit[] = []
  const secrets = new Map<string, string>()
  const token = `vct_${randomBytes(32).toString("base64url")}.synthetic`
  const controller = createVectorAccount({
    read: () => state.stored,
    write: (value) => {
      state.stored = value
    },
    clear: async () => {
      state.stored = undefined
    },
    available: async () => state.secure,
    encrypt: async (value) => {
      if (state.failStorage) throw new Error("synthetic vault failure")
      const ciphertext = randomBytes(32).toString("base64")
      secrets.set(ciphertext, value)
      return ciphertext
    },
    decrypt: async (value) => {
      const secret = secrets.get(value)
      if (!secret) throw new Error("Unknown fixture ciphertext")
      return secret
    },
    openBrowser: async (url) => {
      urls.push(url)
    },
    fetch: async (_url, init) => {
      requests.push(init)
      await state.fetchDelay
      return Response.json({ token, expiresAt: state.now + 100_000, user: { email: "fixture@example.test" } })
    },
    sync: async (value) => {
      tokens.push(value)
      await state.syncDelay
      if (state.failSync) throw new Error("WSL termination not confirmed")
    },
    changed: (status) => statuses.push(status),
    now: () => state.now,
  })
  const callback = () =>
    `vector://auth/callback?${new URLSearchParams({ code: randomBytes(32).toString("base64url"), state: new URL(urls.at(-1)!).searchParams.get("state")! })}`
  return { controller, state, urls, tokens, statuses, requests, token, callback }
}

test("account success notifications wait for managed server synchronization", async () => {
  const app = fixture()
  const released = Promise.withResolvers<void>()
  app.state.syncDelay = released.promise
  await app.controller.start()
  const signingIn = app.controller.consume([app.callback()])
  for (let count = 0; count < 50 && !app.tokens.length; count++) await Bun.sleep(1)
  expect(app.tokens).toEqual([app.token])
  expect(app.statuses).toEqual([{ authenticated: false, pending: true }])
  released.resolve()
  await signingIn
  expect(app.statuses.at(-1)).toMatchObject({ authenticated: true, pending: false })
  app.state.failSync = true
  const stored = app.state.stored
  const status = await app.controller.logout()
  expect(status).toMatchObject({ authenticated: true, error: expect.stringContaining("could not finish signing out") })
  expect(app.state.stored).toEqual(stored)
  expect(app.statuses.at(-1)).toEqual(status)
  app.state.failSync = false
  await app.controller.logout()
  expect(app.state.stored).toBeUndefined()
})

test("desktop owns PKCE exchange and only ciphertext/status cross persistence and renderer boundaries", async () => {
  const app = fixture()
  expect(await app.controller.start()).toMatchObject({ pending: true, authenticated: false })
  const url = new URL(app.urls[0])
  expect(url.origin + url.pathname).toBe("https://vectordev.ai/auth/cli")
  expect(url.searchParams.get("desktop")).toBe("1")
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  expect(url.searchParams.has("verifier")).toBe(false)
  expect(await app.controller.consume([app.callback(), "vector://session/example"])).toEqual([
    "vector://session/example",
  ])
  const exchange = JSON.parse(String(app.requests[0].body))
  expect(createHash("sha256").update(exchange.verifier).digest("base64url")).toBe(
    url.searchParams.get("code_challenge"),
  )
  expect(app.requests[0].redirect).toBe("error")
  expect(app.tokens).toEqual([app.token])
  expect(app.controller.status()).toMatchObject({ authenticated: true, pending: false, email: "fixture@example.test" })
  expect(JSON.stringify([app.state.stored, app.statuses, app.urls])).not.toContain(app.token)
  await app.controller.restore()
  expect(app.tokens).toEqual([app.token, app.token])
  await app.controller.logout()
  expect(app.tokens.at(-1)).toBeUndefined()
  expect(app.state.stored).toBeUndefined()
  expect(app.controller.status()).toEqual({ authenticated: false, pending: false })
})

test("the main-process token is available only while signed in and unexpired", async () => {
  const app = fixture()
  expect(await app.controller.token()).toBeUndefined()
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(await app.controller.token()).toBe(app.token)
  app.state.secure = false
  expect(await app.controller.token()).toBeUndefined()
  app.state.secure = true
  app.state.now += 100_000
  expect(await app.controller.token()).toBeUndefined()
})

test("mismatched, duplicate, expired and cancelled callbacks never forward or exchange credentials", async () => {
  const app = fixture()
  await app.controller.start()
  const callback = app.callback()
  for (const url of [
    callback.replace(/state=[^&]+/, "state=wrong"),
    `${callback}&token=vct_synthetic`,
    "vector://auth/callback?code=bad",
    "vector://auth/other?token=vct_synthetic",
    " vector://auth/callback?code=bad ",
    callback.replace("vector://auth", "vector://unexpected@auth"),
  ])
    expect(await app.controller.consume([url])).toEqual([])
  expect(app.requests).toHaveLength(0)
  await Promise.all([app.controller.consume([callback]), app.controller.consume([callback])])
  expect(app.requests).toHaveLength(1)
  await app.controller.start()
  const cancelled = app.callback()
  app.controller.cancel()
  expect(await app.controller.consume([cancelled])).toEqual([])
  await app.controller.start()
  app.state.now += 300_001
  expect(await app.controller.consume([app.callback()])).toEqual([])
  expect(app.requests).toHaveLength(1)
})

test("unavailable storage prevents browser sign-in and encryption failure never writes plaintext", async () => {
  const app = fixture()
  app.state.secure = false
  expect((await app.controller.start()).error).toContain("securely")
  expect(app.urls).toEqual([])
  app.state.secure = true
  await app.controller.start()
  app.state.failStorage = true
  await app.controller.consume([app.callback()])
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens).toEqual([])
  expect(JSON.stringify(app.statuses)).not.toContain(app.token)
})

test("local credential sync uses authenticated engine routes and refuses remote or redirect targets", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetcher = async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return new Response(null, { status: 200 })
  }
  for (const url of ["https://foreign.example", "http://127.0.0.1.evil.example", "http://user:password@127.0.0.1"])
    await expect(
      syncVectorAccount({ url, username: "vector", password: "synthetic" }, "vct_fixture", fetcher),
    ).rejects.toThrow("local server")
  expect(requests).toEqual([])
  await syncVectorAccount(
    { url: "http://127.0.0.1:9999", username: "vector", password: "synthetic" },
    "vct_fixture",
    fetcher,
  )
  expect(requests.map((item) => [item.url, item.init.method])).toEqual([
    ["http://127.0.0.1:9999/auth/vector", "PUT"],
    ["http://127.0.0.1:9999/global/dispose", "POST"],
  ])
  expect(JSON.parse(String(requests[0].init.body))).toEqual({ type: "api", key: "vct_fixture" })
  expect(new Headers(requests[0].init.headers).get("authorization")).toBe(`Basic ${btoa("vector:synthetic")}`)
  expect(requests.every((item) => item.init.redirect === "error")).toBe(true)
  await syncVectorAccount(
    { url: "http://127.0.0.1:9999", username: "vector", password: "synthetic" },
    undefined,
    fetcher,
  )
  expect(requests[2].init.method).toBe("DELETE")
  expect(requests[2].init.body).toBeUndefined()
})

test("cancelling an exchange in flight prevents storage and expired saved grants are removed", async () => {
  const app = fixture()
  await app.controller.start()
  const response = Promise.withResolvers<void>()
  app.state.fetchDelay = response.promise
  const pending = app.controller.consume([app.callback()])
  expect(app.requests).toHaveLength(1)
  app.controller.cancel()
  response.resolve()
  await pending
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens).toEqual([])
  app.state.fetchDelay = undefined
  await app.controller.start()
  await app.controller.consume([app.callback()])
  app.state.now += 100_001
  await app.controller.restore()
  expect(app.state.stored).toBeUndefined()
  expect(app.tokens.at(-1)).toBeUndefined()
  expect(app.controller.status()).toMatchObject({
    authenticated: false,
    pending: false,
    error: "Your Vector sign-in expired. Sign in again.",
  })
})
