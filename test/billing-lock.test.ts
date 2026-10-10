import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { withBillingMutation } from "../api/_lib/billing-lock"

const environment = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "NODE_ENV",
  "VERCEL_ENV",
] as const
const original = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
const servers: ReturnType<typeof Bun.serve>[] = []

beforeEach(() => {
  environment.forEach((key) => {
    delete process.env[key]
  })
  process.env.NODE_ENV = "production"
})

afterEach(() => {
  servers.splice(0).forEach((server) => server.stop(true))
  environment.forEach((key) => {
    const value = original[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
})

function redis() {
  const state = { owner: "", remaining: 60_000, fail: false, releases: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (state.fail) return Response.json({ error: "unavailable" }, { status: 503 })
      const command = (await request.json()) as string[]
      if (command[0] === "SET") {
        if (state.owner) return Response.json({ result: null })
        state.owner = command[2]!
        return Response.json({ result: "OK" })
      }
      if (command[0] === "EVAL" && command[1]?.includes("PTTL")) {
        return Response.json({ result: state.owner === command[4] ? state.remaining : -1 })
      }
      if (command[0] === "EVAL" && command[1]?.includes("DEL")) {
        if (state.owner !== command[4]) return Response.json({ result: 0 })
        state.owner = ""
        state.releases++
        return Response.json({ result: 1 })
      }
      return Response.json({ error: "Unexpected local Redis command" }, { status: 400 })
    },
  })
  servers.push(server)
  process.env.KV_REST_API_URL = `http://127.0.0.1:${server.port}`
  process.env.KV_REST_API_TOKEN = "local-test-only"
  return state
}

describe("distributed license mutation lock", () => {
  test("production fails closed when Redis is not configured", async () => {
    const calls: string[] = []
    await expect(
      withBillingMutation("cus_test", async () => {
        calls.push("mutation")
      }),
    ).rejects.toMatchObject({ code: "BILLING_LOCK_UNAVAILABLE" })
    expect(calls).toEqual([])
  })

  test("production never uses an in-process fallback during a Redis outage", async () => {
    const state = redis()
    state.fail = true
    const calls: string[] = []
    await expect(
      withBillingMutation("cus_test", async () => {
        calls.push("mutation")
      }),
    ).rejects.toMatchObject({ code: "BILLING_LOCK_UNAVAILABLE" })
    expect(calls).toEqual([])
  })

  test("concurrent mutations for one customer cannot both enter the fresh-read section", async () => {
    const state = redis()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const first = withBillingMutation("cus_test", async (verify) => {
      entered.resolve()
      await release.promise
      await verify()
      calls.push("first")
    })
    await entered.promise
    await expect(
      withBillingMutation("cus_test", async () => {
        calls.push("second")
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "BILLING_MUTATION_BUSY" })
    release.resolve()
    await first
    expect(calls).toEqual(["first"])
    expect(state.owner).toBe("")
    expect(state.releases).toBe(1)
  })

  test.each([15_000, 10_000, 0, -1])("refuses a write when remaining lease time is %s ms", async (remaining) => {
    const state = redis()
    state.remaining = remaining
    const writes: string[] = []
    await expect(
      withBillingMutation("cus_test", async (verify) => {
        await verify()
        writes.push("updated")
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "BILLING_LOCK_EXPIRED" })
    expect(writes).toEqual([])
  })

  test("an expired owner cannot write or release a replacement owner's lease", async () => {
    const state = redis()
    const writes: string[] = []
    await expect(
      withBillingMutation("cus_test", async (verify) => {
        state.owner = "replacement-owner"
        await verify()
        writes.push("updated")
      }),
    ).rejects.toMatchObject({ code: "BILLING_LOCK_EXPIRED" })
    expect(state.owner).toBe("replacement-owner")
    expect(state.releases).toBe(0)
    expect(writes).toEqual([])
  })

  test("keeps an uncertain Stripe timeout leased until expiry before allowing a retry", async () => {
    const state = redis()
    await expect(
      withBillingMutation("cus_test", async () => {
        throw new Error("Stripe timeout")
      }),
    ).rejects.toThrow("Stripe timeout")
    expect(state.owner).not.toBe("")
    await expect(withBillingMutation("cus_test", async () => "overlapped")).rejects.toMatchObject({
      code: "BILLING_MUTATION_BUSY",
    })
    state.owner = ""
    await expect(
      withBillingMutation("cus_test", async (verify) => {
        await verify()
        return "retried"
      }),
    ).resolves.toBe("retried")
  })
})
