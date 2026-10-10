import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "path"
import { rm } from "fs/promises"
import { Global } from "@vectordevai/core/global"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { UsageReport } from "@vectordevai/schema/usage-report"
import { sendUsageReport } from "../../src/cli/usage-report"

const FILE = path.join(Global.Path.data, "cli-usage.json")
const TOKEN = "vct_synthetic-usage-fixture"
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 10, 9, 30)
const servers: ReturnType<typeof Bun.serve>[] = []

// The engine's local summary, as GET /experimental/session/usage returns it.
const local = {
  lifetimeTokens: 420_000,
  lifetimeCost: 3.5,
  inputTokens: 300_000,
  outputTokens: 90_000,
  reasoningTokens: 10_000,
  cachedTokens: 20_000,
  peakTokens: 120_000,
  longestTaskMs: 300_000,
  longestTaskTokens: 50_000,
  averageTaskMs: 30_000,
  currentStreak: 2,
  longestStreak: 4,
  completedChats: 14,
  conversations: 6,
  activeDays: 5,
  averageTokensPerChat: 30_000,
  modelResponses: 88,
  favoriteModels: [
    { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 420_000, responses: 88, percentage: 100 },
  ],
  effortLevels: [{ id: "default", label: "Default", tokens: 420_000, responses: 88, percentage: 100 }],
  days: [{ date: "2026-10-10", tokens: 42_000, cost: 0.35, tasks: 3 }],
}

function site(status = 204) {
  const state = { status, requests: [] as Array<{ authorization: string | null; body: Record<string, unknown> }> }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/api/usage/checkin") return new Response("missing", { status: 404 })
      state.requests.push({ authorization: request.headers.get("authorization"), body: await request.json() })
      return new Response(null, { status: state.status })
    },
  })
  servers.push(server)
  return { state, origin: server.url.origin }
}

beforeEach(async () => {
  await rm(FILE, { force: true })
})

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
  delete process.env.VECTOR_DISABLE_USAGE
})

test("sends the local usage report as the CLI with its account token, once per UTC day", async () => {
  const fixture = site()
  const send = (now: number) =>
    sendUsageReport({ token: TOKEN, site: fixture.origin, now, summary: () => Promise.resolve(local) })

  expect(await send(NOW)).toBe(true)
  expect(await send(NOW + 60_000)).toBe(false)
  expect(fixture.state.requests).toHaveLength(1)

  const first = fixture.state.requests[0]
  expect(first.authorization).toBe(`Bearer ${TOKEN}`)
  expect(first.body).toEqual({
    installId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    client: "cli",
    version: InstallationVersion,
    platform: process.platform,
    arch: process.arch,
    usage: UsageReport.fromSummary(local),
  })
  expect(JSON.stringify(first.body)).not.toContain("peakTokens")

  // The next UTC day sends again, from the same install.
  expect(await send(NOW + DAY)).toBe(true)
  expect(fixture.state.requests.map((request) => request.body.installId)).toEqual([
    first.body.installId,
    first.body.installId,
  ])
  expect(await Bun.file(FILE).json()).toEqual({ installId: first.body.installId, sent: "2026-10-11" })
})

test("VECTOR_DISABLE_USAGE sends nothing and stores nothing", async () => {
  for (const value of ["1", "true"]) {
    const fixture = site()
    process.env.VECTOR_DISABLE_USAGE = value
    const read = { calls: 0 }

    expect(
      await sendUsageReport({
        token: TOKEN,
        site: fixture.origin,
        now: NOW,
        summary: async () => {
          read.calls++
          return local
        },
      }),
    ).toBe(false)

    expect(read.calls).toBe(0)
    expect(fixture.state.requests).toHaveLength(0)
    expect(await Bun.file(FILE).exists()).toBe(false)
  }
})

test("a report that is not accepted is tried again later the same day, from the same install", async () => {
  const fixture = site(503)
  const send = () =>
    sendUsageReport({ token: TOKEN, site: fixture.origin, now: NOW, summary: () => Promise.resolve(local) })

  expect(await send()).toBe(false)
  const stored = await Bun.file(FILE).json()
  expect(stored).toEqual({ installId: expect.any(String) })

  fixture.state.status = 204
  expect(await send()).toBe(true)
  expect(fixture.state.requests.map((request) => request.body.installId)).toEqual([stored.installId, stored.installId])
})

test("sends nothing when the summary cannot be read, and never throws when the site is unreachable", async () => {
  const fixture = site()
  for (const summary of [
    () => Promise.reject(new Error("database locked")),
    () => Promise.resolve({ lifetimeTokens: 1 }),
  ])
    expect(await sendUsageReport({ token: TOKEN, site: fixture.origin, now: NOW, summary })).toBe(false)
  expect(fixture.state.requests).toHaveLength(0)

  expect(
    await sendUsageReport({
      token: TOKEN,
      site: "http://127.0.0.1:9",
      now: NOW,
      summary: () => Promise.resolve(local),
    }),
  ).toBe(false)
})

test("reads the summary in-process from the engine service behind /experimental/session/usage", async () => {
  const fixture = site()

  expect(await sendUsageReport({ token: TOKEN, site: fixture.origin, now: NOW })).toBe(true)

  const usage = fixture.state.requests[0]?.body.usage
  expect(UsageReport.decode(usage)._tag).toBe("Some")
  expect(usage).toMatchObject({ lifetimeTokens: expect.any(Number), days: expect.any(Array) })
})
