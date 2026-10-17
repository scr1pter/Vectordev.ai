import { expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { createVectorAccount, syncVectorAccount } from "./vector-account"

const PHOTO = "https://lh3.googleusercontent.com/a/fixture=s96-c"
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fixture() {
  const state = {
    stored: undefined as unknown,
    secure: true,
    now: 1_000,
    failStorage: false,
    fetchDelay: undefined as Promise<void> | undefined,
    syncDelay: undefined as Promise<void> | undefined,
    failSync: false,
    codium: {} as Record<string, unknown>,
    name: undefined as string | undefined,
    avatar: undefined as string | undefined,
    ttl: 100_000,
    profile: undefined as Record<string, unknown> | undefined,
    photo: () => new Response(png, { headers: { "content-type": "image/png" } }),
  }
  const fetched: string[] = []
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
    fetch: async (url, init) => {
      fetched.push(url)
      requests.push(init)
      if (url === "https://vectordev.ai/api/model-plans/status") return Response.json(state.codium)
      if (url === "https://vectordev.ai/api/account/profile")
        return state.profile ? Response.json(state.profile) : new Response(null, { status: 503 })
      if (url !== "https://vectordev.ai/api/account/cli-exchange") return state.photo()
      await state.fetchDelay
      return Response.json({
        token,
        expiresAt: state.now + state.ttl,
        user: {
          email: "fixture@example.test",
          ...(state.name === undefined ? {} : { name: state.name }),
          ...(state.avatar === undefined ? {} : { avatar: state.avatar }),
        },
      })
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
  return { controller, state, urls, tokens, statuses, requests, fetched, token, callback }
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

test("Codium balances are read in the main process and only the result reaches the renderer", async () => {
  const app = fixture()
  expect(await app.controller.codium()).toMatchObject({ signedIn: false })
  expect(app.fetched).toEqual([])
  await app.controller.start()
  await app.controller.consume([app.callback()])
  // vectordev.ai answers shares and flags, never an amount of credits.
  app.state.codium = {
    enabled: true,
    active: true,
    access: true,
    plan: { id: "vector-50", name: "Codium 50", left: 0.5, renewsAt: 2_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: true, state: "available" },
    empty: false,
    low: false,
  }
  const status = await app.controller.codium()
  expect(app.fetched.at(-1)).toBe("https://vectordev.ai/api/model-plans/status")
  expect(new Headers(app.requests.at(-1)!.headers).get("authorization")).toBe(`Bearer ${app.token}`)
  expect(app.requests.at(-1)!.redirect).toBe("error")
  expect(status).toEqual({
    signedIn: true,
    enabled: true,
    access: true,
    plan: { id: "vector-50", name: "Codium 50", left: 0.5, renewsAt: 2_000_000, cancelAtPeriodEnd: false },
    purchased: { bought: true, state: "available" },
    empty: false,
    low: false,
  })
  expect(JSON.stringify(status)).not.toContain(app.token)
})

test("the signed-in name is kept for the sidebar, and older sign-ins without one still work", async () => {
  const app = fixture()
  app.state.name = "  Ada Lovelace  "
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(app.controller.status()).toMatchObject({
    authenticated: true,
    email: "fixture@example.test",
    name: "Ada Lovelace",
  })
  expect(app.state.stored).toMatchObject({ email: "fixture@example.test", name: "Ada Lovelace" })
  const { name: _, ...older } = app.state.stored as { name: string }
  app.state.stored = older
  const status = app.controller.status()
  expect(status).toMatchObject({ authenticated: true, email: "fixture@example.test" })
  expect(status).not.toHaveProperty("name")
})

test("a missing or blank name never fails sign-in", async () => {
  const app = fixture()
  app.state.name = "   "
  await app.controller.start()
  await app.controller.consume([app.callback()])
  expect(app.controller.status()).toMatchObject({ authenticated: true, email: "fixture@example.test" })
  expect(app.controller.status()).not.toHaveProperty("name")
  expect(app.state.stored).not.toHaveProperty("name")
})

test("sign-in downloads the photo in the main process and the renderer only ever gets a data URL", async () => {
  const app = fixture()
  app.state.avatar = PHOTO
  await app.controller.start()
  await app.controller.consume([app.callback()])
  const photo = `data:image/png;base64,${png.toString("base64")}`
  expect(app.controller.status()).toMatchObject({ authenticated: true, avatar: photo })
  expect(app.state.stored).toMatchObject({ avatar: photo, avatarSource: PHOTO, profileAt: app.state.now })
  expect(app.statuses.at(-1)).toMatchObject({ avatar: photo })
  expect(app.fetched.at(-1)).toBe(PHOTO)
  // Google gets a plain image request: no account token, and no redirects to somewhere else.
  expect(app.requests.at(-1)!.redirect).toBe("error")
  expect(new Headers(app.requests.at(-1)!.headers).has("authorization")).toBe(false)
  expect(JSON.stringify(app.statuses)).not.toContain(PHOTO)
  await app.controller.logout()
  expect(app.controller.status()).not.toHaveProperty("avatar")
})

test("a saved sign-in refreshes its name and photo at most once a day and only while signed in", async () => {
  const app = fixture()
  app.state.ttl = 90 * 24 * 60 * 60 * 1_000
  expect(await app.controller.refreshProfile()).toEqual({ authenticated: false, pending: false })
  expect(app.fetched).toEqual([])
  await app.controller.start()
  await app.controller.consume([app.callback()])
  // A sign-in saved before names and photos were carried.
  app.state.stored = {
    ciphertext: (app.state.stored as { ciphertext: string }).ciphertext,
    email: "fixture@example.test",
    expiresAt: app.state.now + app.state.ttl,
  }
  app.state.profile = { name: "  Ada Lovelace ", avatar: PHOTO }
  const count = app.fetched.length
  expect(await app.controller.refreshProfile()).toMatchObject({
    name: "Ada Lovelace",
    avatar: `data:image/png;base64,${png.toString("base64")}`,
  })
  expect(app.fetched.slice(count)).toEqual(["https://vectordev.ai/api/account/profile", PHOTO])
  const profile = app.requests[count]
  expect(new Headers(profile.headers).get("authorization")).toBe(`Bearer ${app.token}`)
  expect(profile.redirect).toBe("error")
  await app.controller.refreshProfile()
  app.state.now += 23 * 60 * 60 * 1_000
  await app.controller.refreshProfile()
  expect(app.fetched.length).toBe(count + 2)
  // A day later the profile is asked again, and the unchanged photo is not downloaded again.
  app.state.now += 60 * 60 * 1_000
  await app.controller.refreshProfile()
  expect(app.fetched.slice(count + 2)).toEqual(["https://vectordev.ai/api/account/profile"])
  app.state.now += app.state.ttl
  await app.controller.refreshProfile()
  expect(app.fetched.length).toBe(count + 3)
})

test("photos outside Google's avatar hosts, of other types or over 256 KB are never kept", async () => {
  const sources = [
    "https://evil.example/photo.png",
    "http://lh3.googleusercontent.com/a/fixture",
    "https://lh3.googleusercontent.com.evil.example/a/fixture",
    "https://1.2.3.4.bc.googleusercontent.com/a/fixture",
    "https://user@lh3.googleusercontent.com/a/fixture",
    "https://lh3.googleusercontent.com:8443/a/fixture",
    `https://lh3.googleusercontent.com/a/${"x".repeat(2_100)}`,
  ]
  for (const source of sources) {
    const app = fixture()
    app.state.avatar = source
    await app.controller.start()
    await app.controller.consume([app.callback()])
    expect(app.fetched).toEqual(["https://vectordev.ai/api/account/cli-exchange"])
    expect(app.controller.status()).toMatchObject({ authenticated: true })
    expect(app.controller.status()).not.toHaveProperty("avatar")
  }
  const responses = [
    () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } }),
    () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    () => new Response(png, { status: 404, headers: { "content-type": "image/png" } }),
    () => new Response(new Uint8Array(0), { headers: { "content-type": "image/png" } }),
    () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(300 * 1024) } }),
    // A body larger than it says: the cap holds while reading.
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            Array.from({ length: 5 }, () => controller.enqueue(new Uint8Array(64 * 1024)))
            controller.close()
          },
        }),
        { headers: { "content-type": "image/jpeg" } },
      ),
    () => {
      throw new TypeError("fetch failed: redirect mode is set to error")
    },
  ]
  for (const response of responses) {
    const app = fixture()
    app.state.avatar = PHOTO
    app.state.photo = response
    await app.controller.start()
    await app.controller.consume([app.callback()])
    expect(app.fetched.at(-1)).toBe(PHOTO)
    expect(app.controller.status()).toMatchObject({ authenticated: true })
    expect(app.controller.status()).not.toHaveProperty("avatar")
    // Not settled, so the next start tries the photo again.
    expect(app.state.stored).not.toHaveProperty("profileAt")
  }
})

test("a failed refresh keeps the last good photo, and a profile without one falls back to the initial", async () => {
  const app = fixture()
  app.state.ttl = 90 * 24 * 60 * 60 * 1_000
  app.state.avatar = PHOTO
  await app.controller.start()
  await app.controller.consume([app.callback()])
  const photo = app.controller.status().avatar
  expect(photo).toStartWith("data:image/png;base64,")
  app.state.now += 25 * 60 * 60 * 1_000
  // vectordev.ai unavailable: nothing changes and nothing is settled.
  await app.controller.refreshProfile()
  expect(app.controller.status()).toMatchObject({ avatar: photo })
  // A new photo that cannot be downloaded keeps the old one.
  app.state.profile = { name: null, avatar: `${PHOTO}-new` }
  app.state.photo = () => new Response(null, { status: 500 })
  await app.controller.refreshProfile()
  expect(app.controller.status()).toMatchObject({ avatar: photo })
  expect(app.state.stored).toMatchObject({ avatarSource: PHOTO })
  // The account has no photo any more.
  app.state.profile = { name: null, avatar: null }
  await app.controller.refreshProfile()
  expect(app.controller.status()).not.toHaveProperty("avatar")
  expect(app.state.stored).not.toHaveProperty("avatarSource")
  // A saved value that is not an inline image never reaches the renderer.
  app.state.stored = { ...(app.state.stored as object), avatar: PHOTO, avatarSource: PHOTO }
  expect(app.controller.status()).not.toHaveProperty("avatar")
})

test("signing out while the photo downloads keeps the account signed out", async () => {
  const app = fixture()
  app.state.avatar = PHOTO
  const released = Promise.withResolvers<void>()
  app.state.photo = () => {
    void app.controller.logout()
    return new Response(
      new ReadableStream({
        async start(controller) {
          await released.promise
          controller.enqueue(png)
          controller.close()
        },
      }),
      { headers: { "content-type": "image/png" } },
    )
  }
  await app.controller.start()
  const signingIn = app.controller.consume([app.callback()])
  for (let count = 0; count < 50 && app.state.stored; count++) await Bun.sleep(1)
  released.resolve()
  await signingIn
  expect(app.state.stored).toBeUndefined()
  expect(app.controller.status()).toEqual({ authenticated: false, pending: false })
})
