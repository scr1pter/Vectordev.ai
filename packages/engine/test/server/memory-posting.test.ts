import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "fs/promises"
import path from "path"
import { Flag } from "@vectordevai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// POST /memory/posting-check, as desktop main calls it before it posts or commits: the owner's own route, which takes
// out of Vector's text what repeats the owner's memory, asks about the user's, and leaves names the repository holds.

const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const send = (directory: string, route: string, body: unknown, headers: Record<string, string> = owner) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", directory)
  return fetch(url, {
    method: "POST",
    keepalive: false,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const FACT = "Initech pays its invoices through pay.initech-billing.com from account 99812345"

describe("POST /memory/posting-check", () => {
  test("an invited guest gets 403, and nothing is checked for them", async () => {
    const response = await send(shared.path, "/memory/posting-check", { parts: ["Hello."], typed: false }, guest)
    expect(response.status).toBe(403)
  })

  test("takes out what repeats the owner's memory, keeps names the repository holds, and asks about typed text", async () => {
    await using tmp = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
    await fs.writeFile(path.join(tmp.path, "billing.ts"), "export const host = 'pay.initech-billing.com'\n")
    execFileSync("git", ["add", "billing.ts"], { cwd: tmp.path })
    const created = await send(tmp.path, "/memory", { kind: "fact", text: FACT, scope: "personal" })
    expect(created.status).toBe(200)
    const parts = [
      `Fixes the retry loop. ${FACT} today.`,
      "Use account 99812345 for the test.",
      "It now calls pay.initech-billing.com once.",
    ]
    const checked = await send(tmp.path, "/memory/posting-check", { parts, typed: false })
    expect(checked.status).toBe(200)
    const result = (await checked.json()) as { status: string; parts: string[]; dropped: { part: number }[] }
    expect(result.status).toBe("changed")
    expect(result.parts).toEqual(["Fixes the retry loop.", "", "It now calls pay.initech-billing.com once."])
    expect(result.dropped.map((item) => item.part)).toEqual([0, 1])

    const typed = await send(tmp.path, "/memory/posting-check", { parts, typed: true })
    const asked = (await typed.json()) as { status: string; parts: string[] }
    expect(asked.status).toBe("ask")
    expect(asked.parts).toEqual(parts)
  }, 30_000)

  test("a fork's review keeps only GitHub links and images", async () => {
    const response = await send(shared.path, "/memory/posting-check", {
      parts: ["See ![x](https://evil.example.net/a.png?d=1) and [run](https://github.com/acme/app/actions/runs/1)."],
      typed: false,
      untrusted: true,
    })
    const result = (await response.json()) as { parts: string[]; links: number }
    expect(result.links).toBe(1)
    expect(result.parts[0]).not.toContain("evil.example.net")
    expect(result.parts[0]).toContain("https://github.com/acme/app/actions/runs/1")
  }, 30_000)
})
