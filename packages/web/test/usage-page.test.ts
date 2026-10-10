import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { UsageSummary } from "@vectordevai/schema/usage-summary"
import { readShared, shareTokenFrom } from "../src/components/marketing/usage/shared-link"

// This package's tsconfig compiles JSX for Solid, and Astro builds the React islands itself. To render the dashboard
// here, its React files are compiled with React's automatic runtime, as Astro does.
const react = new Bun.Transpiler({
  loader: "tsx",
  autoImportJSX: true,
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
})
Bun.plugin({
  name: "react islands",
  setup(build) {
    build.onLoad({ filter: /components\/marketing\/(usage|account)\/[^/]+\.tsx$/ }, async (args) => ({
      contents: react.transformSync(await Bun.file(args.path).text()),
      loader: "js",
    }))
  },
})
const { Dashboard } = await import("../src/components/marketing/usage/UsageDashboard")

const TOKEN = "Q2hhcmFjdGVycyBvZiBhIHNoYXJlIGxpbmsgdG9rZW4"
const summary: UsageSummary.Summary = {
  generatedAt: "2026-10-10T09:00:00Z",
  today: "2026-10-10",
  totals: {
    accounts: 40,
    installs: 31,
    cliAccounts: 9,
    downloads: 52,
    downloadAccounts: 33,
    activeToday: 11,
    active7: 24,
    previous7: 20,
    active30: 35,
    sessions7: 310,
    subagentSessions7: 95,
  },
  daily: [
    {
      day: "2026-10-09",
      active: 10,
      desktop: 8,
      cli: 3,
      sessions: 40,
      subagentSessions: 12,
      tokens: 2_000_000,
      cost: 20,
      tasks: 40,
    },
    {
      day: "2026-10-10",
      active: 11,
      desktop: 9,
      cli: 3,
      sessions: 44,
      subagentSessions: 13,
      tokens: 2_400_000,
      cost: 31.5,
      tasks: 52,
    },
  ],
  weekly: [{ week: "2026-10-05", active: 24, desktop: 20, cli: 6, growth: 0.2 }],
  monthly: [{ month: "2026-10-01", active: 30 }],
  retention: [{ cohort: "2026-09-14", size: 10, weeks: [0.6, 0.5, null, null] }],
  funnel: [{ week: "2026-10-05", signups: 6, downloaded: 4, active: 3 }],
  versions: [{ client: "desktop", version: "1.99.106", active: 18 }],
  platforms: [{ client: "desktop", platform: "darwin", arch: "arm64", active: 15 }],
  usage: {
    reporting: 30,
    lifetimeTokens: 98_000_000,
    lifetimeCost: 1_204.5,
    inputTokens: 60_000_000,
    outputTokens: 20_000_000,
    reasoningTokens: 6_000_000,
    cachedTokens: 12_000_000,
    completedChats: 2_400,
    conversations: 800,
    modelResponses: 21_000,
    tokens7: 14_000_000,
    previousTokens7: 11_000_000,
    cost7: 180.25,
    previousCost7: 150,
    tokensPerActive7: 583_333,
  },
  models: [
    { providerID: "anthropic", modelID: "claude-sonnet-4-5", tokens: 60_000_000, people: 18, share: 0.6 },
    { providerID: "openai", modelID: "gpt-5-codex", tokens: 20_000_000, people: 7, share: 0.2 },
  ],
  efforts: [{ id: "default", label: "Default", tokens: 70_000_000, responses: 15_000, people: 20, share: 1 }],
  streaks: { one: 6, twoToSix: 9, sevenPlus: 3 },
}

test("the owner's usage dashboard survives the production prune", async () => {
  const root = await mkdtemp(join(tmpdir(), "vector-usage-prune-"))
  const dist = join(root, "packages/web/dist")
  await mkdir(join(root, "script"), { recursive: true })
  await mkdir(join(dist, "usage"), { recursive: true })
  await mkdir(join(dist, "unpublished"), { recursive: true })
  await Bun.write(join(dist, "index.html"), "landing")
  await Bun.write(join(dist, "usage/index.html"), "usage dashboard")
  await cp(
    new URL("../../../script/prune-vector-site.mjs", import.meta.url),
    join(root, "script/prune-vector-site.mjs"),
  )
  const prune = Bun.spawn(["node", join(root, "script/prune-vector-site.mjs")], { stdout: "pipe", stderr: "pipe" })
  expect(await prune.exited).toBe(0)
  expect(await Bun.file(join(dist, "usage/index.html")).text()).toBe("usage dashboard")
  expect(await Bun.file(join(dist, "unpublished")).exists()).toBe(false)
  await rm(root, { recursive: true, force: true })
})

test("a share link's token comes from the address fragment and is sent only in a header, without cookies", async () => {
  expect(shareTokenFrom(`#share=${TOKEN}`)).toBe(TOKEN)
  expect(shareTokenFrom(`share=${TOKEN}`)).toBe(TOKEN)
  expect(shareTokenFrom("#other=1")).toBeNull()
  expect(shareTokenFrom("")).toBeNull()

  const calls: Array<{ input: unknown; init?: RequestInit }> = []
  const view = await readShared(TOKEN, (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init })
    return Response.json({ shared: { expiresAt: "2026-10-24T09:00:00Z" }, summary })
  }) as typeof fetch)

  expect(view).toEqual({ kind: "ready", summary, shared: { expiresAt: "2026-10-24T09:00:00Z" } })
  expect(calls).toEqual([
    {
      input: "/api/usage/summary",
      init: {
        headers: { accept: "application/json", "x-vector-usage-share": TOKEN },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      },
    },
  ])
})

test("an expired, turned-off or unknown link says why, and a malformed one never leaves the page", async () => {
  const answering = (status: number, code: string) =>
    (async () => Response.json({ error: { code, message: "x" } }, { status })) as unknown as typeof fetch
  expect(await readShared(TOKEN, answering(410, "SHARE_EXPIRED"))).toMatchObject({
    kind: "closed",
    title: "This link has expired",
  })
  expect(await readShared(TOKEN, answering(410, "SHARE_REVOKED"))).toMatchObject({
    kind: "closed",
    title: "This link was turned off",
  })
  expect(await readShared(TOKEN, answering(404, "SHARE_NOT_FOUND"))).toMatchObject({
    kind: "closed",
    title: "This link isn't valid",
  })

  const calls: unknown[] = []
  const never = (async (input: unknown) => {
    calls.push(input)
    return Response.json({})
  }) as typeof fetch
  for (const token of ["short", `${TOKEN}\n`, `${TOKEN}${TOKEN}`])
    expect(await readShared(token, never)).toMatchObject({ kind: "closed", title: "This link isn't valid" })
  expect(calls).toHaveLength(0)
})

test("a share link reports numbers that cannot load instead of drawing them", async () => {
  const down = (async () =>
    Response.json(
      { error: { code: "USAGE_UNAVAILABLE", message: "Usage counts are not available right now." } },
      { status: 503 },
    )) as unknown as typeof fetch
  await expect(readShared(TOKEN, down)).rejects.toThrow("Usage counts are not available right now.")
  const malformed = (async () =>
    Response.json({
      shared: { expiresAt: "soon" },
      summary: { ...summary, usage: undefined },
    })) as unknown as typeof fetch
  await expect(readShared(TOKEN, malformed)).rejects.toThrow("Usage could not load.")
})

test("a shared view is read-only: the banner and the numbers, no refresh, account or share-link controls", () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, { summary, shared: { expiresAt: "2026-10-24T09:00:00Z" }, onRefresh: () => undefined }),
  )
  expect(html).toContain("Shared by Vector · read-only · expires Oct 24, 2026")
  for (const section of [
    "Model use",
    "Tokens, 7 days",
    "Model cost, 7 days",
    "Tokens per active person",
    "Tokens per day",
    "Model cost per day",
    "Top models",
    "Effort mix",
    "Streaks",
    "Tokens by type",
  ])
    expect(html).toContain(section)
  expect(html).toContain("claude-sonnet-4-5")
  expect(html).toContain("All other models: 20%")
  expect(html).toContain("+27% on the week before")
  for (const control of ["Refresh", 'href="/account"', "Share a read-only link", "Make link"])
    expect(html).not.toContain(control)
})

test("the owner's view has the refresh, account and share-link controls", () => {
  const html = renderToStaticMarkup(
    createElement(Dashboard, { summary, onRefresh: () => undefined, authorize: async () => "owner-session" }),
  )
  for (const control of ["Refresh", 'href="/account"', "Share a read-only link", "Make link", "7 days", "30 days"])
    expect(html).toContain(control)
  expect(html).not.toContain("Shared by Vector")
})
