import { afterEach, expect, test } from "bun:test"
import { createUsageCheckin, usageCheckinEndpoint } from "./usage-checkin"

const DAY = 24 * 60 * 60 * 1000
const TODAY = Date.UTC(2026, 9, 9, 15, 30)
const TOKEN = "vct_placeholder-account-token"
const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
})

function fixture(input: { pages?: unknown[][]; listStatus?: number; checkinStatus?: number } = {}) {
  const state = {
    now: TODAY,
    enabled: true,
    token: TOKEN as string | undefined,
    checkinStatus: input.checkinStatus ?? 204,
  }
  const lists: Array<{ query: URLSearchParams; authorization: string | null }> = []
  const checkins: Array<{ body: unknown; authorization: string | null }> = []
  const pages = input.pages ?? [[]]
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/experimental/session") {
        lists.push({ query: url.searchParams, authorization: request.headers.get("authorization") })
        if (input.listStatus) return new Response("unavailable", { status: input.listStatus })
        const index = Number(url.searchParams.get("cursor") ?? "0")
        return Response.json(pages[index] ?? [], {
          headers: index + 1 < pages.length ? { "x-next-cursor": String(index + 1) } : {},
        })
      }
      if (url.pathname === "/api/usage/checkin") {
        checkins.push({ body: await request.json(), authorization: request.headers.get("authorization") })
        return new Response(null, { status: state.checkinStatus })
      }
      return new Response("missing", { status: 404 })
    },
  })
  servers.push(server)
  const store = new Map<string, unknown>()
  const options = {
    endpoint: new URL("/api/usage/checkin", server.url).href as string | undefined,
    store: { get: (key: string) => store.get(key), set: (key: string, value: unknown) => store.set(key, value) },
    enabled: () => state.enabled,
    engine: { url: server.url.href, username: "vector", password: "placeholder-password" },
    token: async () => state.token,
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    now: () => state.now,
    version: "1.99.105",
    platform: "darwin",
    arch: "arm64",
  }
  return { state, lists, checkins, store, options, usage: createUsageCheckin(options) }
}

test("sends today's root and subagent session counts once per UTC day", async () => {
  const app = fixture({
    pages: [
      [
        { id: "ses_a", title: "private title", directory: "/private/repo" },
        { id: "ses_b", parentID: "ses_a" },
      ],
      [{ id: "ses_c" }, { id: "ses_d", parentID: "ses_c" }, { id: "ses_e", parentID: "ses_c" }],
    ],
  })

  expect(await app.usage.checkin()).toBe(true)

  expect(app.lists.map((list) => list.query.get("start"))).toEqual([
    String(Date.UTC(2026, 9, 9)),
    String(Date.UTC(2026, 9, 9)),
  ])
  expect(app.lists[0].query.get("archived")).toBe("true")
  expect(app.lists[1].query.get("cursor")).toBe("1")
  expect(app.lists[0].authorization).toBe(`Basic ${Buffer.from("vector:placeholder-password").toString("base64")}`)
  expect(app.checkins).toHaveLength(1)
  expect(app.checkins[0].authorization).toBe(`Bearer ${TOKEN}`)
  const installId = app.store.get("installId")
  expect(installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(app.checkins[0].body).toEqual({
    installId,
    client: "desktop",
    version: "1.99.105",
    platform: "darwin",
    arch: "arm64",
    sessions: 2,
    subagentSessions: 3,
  })

  expect(await app.usage.checkin()).toBe(false)
  expect(app.checkins).toHaveLength(1)

  app.state.now = TODAY + DAY
  expect(await app.usage.checkin()).toBe(true)
  expect(app.checkins).toHaveLength(2)
  expect(app.checkins[1].body).toMatchObject({ installId })
})

test("leaves out the account header when signed out", async () => {
  const app = fixture()
  app.state.token = undefined

  expect(await app.usage.checkin()).toBe(true)

  expect(app.checkins[0].authorization).toBeNull()
})

test("still checks in with zero counts when the local server cannot list sessions", async () => {
  const app = fixture({ listStatus: 503 })
  const failing = createUsageCheckin({
    ...app.options,
    token: async () => {
      throw new Error("credential store locked")
    },
  })

  expect(await failing.checkin()).toBe(true)

  expect(app.checkins[0].authorization).toBeNull()
  expect(app.checkins[0].body).toMatchObject({ sessions: 0, subagentSessions: 0 })
})

test("retries later the same day when the check-in is not accepted", async () => {
  const app = fixture({ checkinStatus: 503 })

  expect(await app.usage.checkin()).toBe(false)
  expect(app.store.has("sentDay")).toBe(false)

  app.state.checkinStatus = 204
  expect(await app.usage.checkin()).toBe(true)
  expect(app.checkins).toHaveLength(2)
  expect(app.store.get("sentDay")).toBe("2026-10-09")
})

test("never throws when the site is unreachable", async () => {
  const app = fixture()
  const offline = createUsageCheckin({ ...app.options, endpoint: "http://127.0.0.1:9/api/usage/checkin" })

  expect(await offline.checkin()).toBe(false)
  expect(app.store.has("sentDay")).toBe(false)
})

test("sends nothing and creates no install ID while sharing is off", async () => {
  const app = fixture()
  app.state.enabled = false

  expect(await app.usage.checkin()).toBe(false)

  expect(app.lists).toHaveLength(0)
  expect(app.checkins).toHaveLength(0)
  expect(app.store.size).toBe(0)
})

test("sends nothing without an endpoint", async () => {
  const app = fixture()
  const development = createUsageCheckin({ ...app.options, endpoint: undefined })

  expect(await development.checkin()).toBe(false)

  expect(app.lists).toHaveLength(0)
  expect(app.checkins).toHaveLength(0)
})

test("keeps a stored install ID and replaces a malformed one", async () => {
  const app = fixture()
  app.store.set("installId", "not-a-uuid")

  await app.usage.checkin()
  const replaced = app.store.get("installId")
  expect(replaced).not.toBe("not-a-uuid")

  app.state.now = TODAY + DAY
  await app.usage.checkin()
  expect(app.checkins.map((checkin) => (checkin.body as { installId: string }).installId)).toEqual([replaced, replaced])
})

test("concurrent triggers share one check-in", async () => {
  const app = fixture()

  expect(await Promise.all([app.usage.checkin(), app.usage.checkin()])).toEqual([true, true])

  expect(app.checkins).toHaveLength(1)
})

test("start checks in after the delay and stop cancels a pending start", async () => {
  const started = fixture()
  const usage = createUsageCheckin({ ...started.options, delay: 1, interval: 60_000 })
  usage.start()
  for (let count = 0; count < 200 && !started.store.has("sentDay"); count++) await Bun.sleep(5)
  usage.stop()
  expect(started.checkins).toHaveLength(1)

  const stopped = fixture()
  const cancelled = createUsageCheckin({ ...stopped.options, delay: 20, interval: 60_000 })
  cancelled.start()
  cancelled.stop()
  await Bun.sleep(60)
  expect(stopped.lists).toHaveLength(0)
  expect(stopped.checkins).toHaveLength(0)
})

test("only packaged release builds report to vectordev.ai unless a development URL is set", () => {
  expect(usageCheckinEndpoint({ packaged: true, channel: "prod", override: undefined })).toBe(
    "https://vectordev.ai/api/usage/checkin",
  )
  expect(usageCheckinEndpoint({ packaged: true, channel: "beta", override: "http://localhost:3000/x" })).toBe(
    "https://vectordev.ai/api/usage/checkin",
  )
  expect(usageCheckinEndpoint({ packaged: true, channel: "dev", override: undefined })).toBeUndefined()
  expect(usageCheckinEndpoint({ packaged: false, channel: "prod", override: undefined })).toBeUndefined()
  expect(usageCheckinEndpoint({ packaged: false, channel: "prod", override: "not a url" })).toBeUndefined()
  expect(
    usageCheckinEndpoint({ packaged: false, channel: "dev", override: "http://localhost:3000/api/usage/checkin" }),
  ).toBe("http://localhost:3000/api/usage/checkin")
})
