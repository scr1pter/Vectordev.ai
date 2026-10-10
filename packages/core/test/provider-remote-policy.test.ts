import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProviderRemotePolicy } from "../src/provider-remote-policy"

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-provider-policy-"))
  return {
    file: path.join(root, "cache", "provider-policy.json"),
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

function client(
  file: string,
  reply: () => Promise<Response>,
  extra: { disabled?: () => boolean; now?: () => number } = {},
) {
  const seen: boolean[] = []
  const urls: string[] = []
  const policy = ProviderRemotePolicy.createClient({
    file,
    apply: (value) => seen.push(value.chatgptSignIn),
    request: (url) => {
      urls.push(url)
      return reply()
    },
    ...extra,
  })
  return { ...policy, seen, urls }
}

const offline = () => Promise.reject(new Error("offline"))

test("the switch reads vectordev.ai, keeps the last value when unreachable and starts enabled", async () => {
  await using dir = await scratch()

  const first = client(dir.file, offline)
  await first.check()
  // Nothing seen yet: the caller's default (enabled) stays.
  expect(first.seen).toEqual([])
  expect(first.urls).toEqual([ProviderRemotePolicy.POLICY_URL])

  const off = client(dir.file, async () => Response.json({ chatgptSignIn: false, unknownSwitch: 1 }))
  await off.check()
  expect(off.seen).toEqual([false])
  expect(await Bun.file(dir.file).json()).toEqual({ chatgptSignIn: false })

  // A later start that cannot reach the website keeps the owner's last decision.
  const restarted = client(dir.file, offline)
  await restarted.restore()
  expect(restarted.seen).toEqual([false])
  await restarted.check(true)
  expect(restarted.seen).toEqual([false])

  const on = client(dir.file, async () => Response.json({ chatgptSignIn: true }))
  await on.check()
  expect(on.seen).toEqual([false, true])
  expect(await Bun.file(dir.file).json()).toEqual({ chatgptSignIn: true })
})

test("malformed or failed answers never change the switch", async () => {
  await using dir = await scratch()
  for (const reply of [
    async () => new Response("not json", { status: 200 }),
    async () => Response.json({ chatgptSignIn: "no" }),
    async () => Response.json({ chatgptSignIn: false }, { status: 500 }),
    async () => new Response(null, { status: 404 }),
  ]) {
    const policy = client(dir.file, reply)
    await policy.check(true)
    expect(policy.seen).toEqual([])
  }
  await Bun.write(dir.file, "{broken")
  const corrupt = client(dir.file, offline)
  await corrupt.restore()
  expect(corrupt.seen).toEqual([])
})

test("startup reuses a recent read, a sign-in rereads unless one just happened, and checks share a request", async () => {
  await using dir = await scratch()
  const clock = { now: 1_000_000 }
  const answer = Promise.withResolvers<Response>()
  const policy = client(dir.file, () => (policy.urls.length === 1 ? answer.promise : offline()), {
    now: () => clock.now,
  })
  const together = [policy.check(), policy.check(true)]
  answer.resolve(Response.json({ chatgptSignIn: false }))
  await Promise.all(together)
  expect(policy.urls).toHaveLength(1)
  expect(policy.seen).toEqual([false])

  // The server checked moments before the plugin's own sign-in check.
  clock.now += 5_000
  await policy.check(true)
  expect(policy.urls).toHaveLength(1)
  clock.now += 60_000
  await policy.check()
  expect(policy.urls).toHaveLength(1)
  await policy.check(true)
  expect(policy.urls).toHaveLength(2)
  // An unanswered read still counts, so the offline sign-in after it does not wait again.
  await policy.check(true)
  expect(policy.urls).toHaveLength(2)
  clock.now += 10 * 60_000
  await policy.check()
  expect(policy.urls).toHaveLength(3)
  expect(policy.seen).toEqual([false])
})

test("operators who disable Vector's metadata fetches follow the release default", async () => {
  await using dir = await scratch()
  await client(dir.file, async () => Response.json({ chatgptSignIn: false })).check()
  const policy = client(dir.file, async () => Response.json({ chatgptSignIn: false }), { disabled: () => true })
  await policy.restore()
  await policy.check(true)
  expect(policy.urls).toEqual([])
  expect(policy.seen).toEqual([])
})

test("the website publishes the switch where installed apps read it, turned on", async () => {
  const root = path.resolve(import.meta.dir, "../../..")
  const url = new URL(ProviderRemotePolicy.POLICY_URL)
  expect(url.origin).toBe("https://vectordev.ai")
  expect(await Bun.file(path.join(root, "packages/web/public", url.pathname)).json()).toEqual({ chatgptSignIn: true })
  // The deploy deletes every top-level folder it does not keep.
  expect(await Bun.file(path.join(root, "script/prune-vector-site.mjs")).text()).toContain(
    `"${url.pathname.split("/")[1]}"`,
  )
  const config = await Bun.file(path.join(root, "vercel.json")).json()
  expect(
    [...config.rewrites, ...config.redirects].filter((rule: { source: string }) => rule.source.startsWith("/policy")),
  ).toEqual([])
})
