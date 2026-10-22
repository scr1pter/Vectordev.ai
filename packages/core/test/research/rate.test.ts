import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ResearchRate } from "../../src/research/rate"
import { ResearchReader } from "../../src/research/reader"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // Busy every time, and asking for longer than research waits.
    overloaded: {
      "/": { status: 503, headers: { "retry-after": "3600", "content-type": "text/plain" }, body: "Down" },
    },
    // Busy every time, with no Retry-After.
    flooded: { "/": { status: 429, headers: { "content-type": "text/plain" }, body: "Slow down" } },
    challenged: {
      "/": {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
        body: "<title>Just a moment...</title>",
      },
    },
  },
})
afterAll(() => web.close())
const http = Effect.runSync(
  Effect.gen(function* () {
    return yield* HttpClient.HttpClient
  }).pipe(Effect.provide(FetchHttpClient.layer)),
)
const reader = (limiter: ResearchRate.Limiter) => ({
  http,
  authorize: () => Effect.void,
  authorizePrivate: web.authorizePrivate,
  resolver: web.resolver,
  publicNames: [FakeWeb.DOMAIN],
  limiter,
})

describe("ResearchRate.retryAfter", () => {
  test("reads seconds and HTTP dates, and nothing else", () => {
    const now = Date.parse("2026-10-22T12:00:00Z")
    expect(ResearchRate.retryAfter("5", now)).toBe(5_000)
    expect(ResearchRate.retryAfter(" 0 ", now)).toBe(0)
    expect(ResearchRate.retryAfter("Thu, 22 Oct 2026 12:00:30 GMT", now)).toBe(30_000)
    expect(ResearchRate.retryAfter("Thu, 22 Oct 2026 11:00:00 GMT", now)).toBe(0)
    expect(ResearchRate.retryAfter("soon", now)).toBeUndefined()
    expect(ResearchRate.retryAfter(undefined, now)).toBeUndefined()
  })

  test("retries only 429 and 503", () => {
    expect([429, 503, 500, 502, 403, 200].map(ResearchRate.retriable)).toEqual([true, true, false, false, false, false])
  })
})

describe("ResearchRate.challenge", () => {
  test("knows a challenge page by its header or its service's markers", () => {
    expect(ResearchRate.challenge({ status: 403, headers: { "cf-mitigated": "challenge" }, body: "" })).toBe(true)
    expect(
      ResearchRate.challenge({ status: 200, headers: {}, body: '<script src="/cdn-cgi/challenge-platform/x.js">' }),
    ).toBe(true)
    expect(ResearchRate.challenge({ status: 403, headers: {}, body: "Please verify you are a human" })).toBe(true)
  })

  test("does not take a page that only mentions a CAPTCHA for one", () => {
    expect(ResearchRate.challenge({ status: 200, headers: {}, body: "<p>How CAPTCHA systems work</p>" })).toBe(false)
  })
})

describe("ResearchRate.make", () => {
  test("starts requests to one host an interval apart, and other hosts at once", async () => {
    const limiter = ResearchRate.make({ interval: 120 })
    const starts: { host: string; at: number }[] = []
    const request = (host: string) =>
      limiter.run(
        host,
        Effect.sync(() => starts.push({ host, at: Date.now() })),
        () => undefined,
      )
    const began = Date.now()
    await Effect.runPromise(
      Effect.all([request("a.test"), request("A.test"), request("b.test")], { concurrency: "unbounded" }),
    )
    const a = starts.filter((item) => item.host !== "b.test").map((item) => item.at - began)
    const b = starts.filter((item) => item.host === "b.test").map((item) => item.at - began)
    expect(a).toHaveLength(2)
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThanOrEqual(100)
    expect(b[0]!).toBeLessThan(100)
  })

  test("keeps at most 2 requests in flight per host and 4 in all", async () => {
    const limiter = ResearchRate.make({ interval: 0 })
    const state = { host: 0, all: 0, hostMax: 0, allMax: 0 }
    const request = (host: string) =>
      limiter.run(
        host,
        Effect.gen(function* () {
          state.all++
          if (host === "one.test") state.host++
          state.allMax = Math.max(state.allMax, state.all)
          state.hostMax = Math.max(state.hostMax, state.host)
          yield* Effect.sleep(30)
          state.all--
          if (host === "one.test") state.host--
        }),
        () => undefined,
      )
    const hosts = ["one.test", "one.test", "one.test", "one.test", "two.test", "three.test", "four.test", "five.test"]
    await Effect.runPromise(Effect.all(hosts.map(request), { concurrency: "unbounded" }))
    expect(state.hostMax).toBe(2)
    expect(state.allMax).toBe(4)
  })

  test("retries a busy answer at most twice, backing off from the base", async () => {
    const limiter = ResearchRate.make({ interval: 0, backoff: 20 })
    const tries: number[] = []
    const began = Date.now()
    const result = await Effect.runPromise(
      limiter.run(
        "busy.test",
        Effect.sync(() => {
          tries.push(Date.now() - began)
          return 429
        }),
        (status) => (status === 429 ? {} : undefined),
      ),
    )
    expect(result).toBe(429)
    expect(tries).toHaveLength(3)
    // 20 ms, then 40 ms.
    expect(tries[1]! - tries[0]!).toBeGreaterThanOrEqual(15)
    expect(tries[2]! - tries[1]!).toBeGreaterThanOrEqual(35)
  })

  test("leaves a site that asks for more than the most research waits", async () => {
    const limiter = ResearchRate.make({ interval: 0, backoff: 1, maxWait: 1_000 })
    const tries = { count: 0 }
    await Effect.runPromise(
      limiter.run(
        "slow.test",
        Effect.sync(() => ++tries.count),
        () => ({ retryAfter: "120" }),
      ),
    )
    expect(tries.count).toBe(1)
  })
})

describe("rate limits on the fake web", () => {
  test("honours Retry-After on a 429, then reads the page", async () => {
    const began = Date.now()
    const page = await Effect.runPromise(
      ResearchReader.read({ url: web.url("busy", "/") }, reader(ResearchRate.make({ interval: 1, backoff: 10 }))),
    )
    expect(page.status).toBe("read")
    expect(page.text).toContain("412 homes")
    expect(web.count("busy", "/")).toBe(2)
    // Retry-After said 1 second, which is longer than the 10 ms backoff.
    expect(Date.now() - began).toBeGreaterThanOrEqual(950)
  })

  test("says the site is busy after its retries, and does not wait an hour for one", async () => {
    const flooded = await Effect.runPromise(
      ResearchReader.read({ url: web.url("flooded", "/") }, reader(ResearchRate.make({ interval: 1, backoff: 5 }))),
    )
    expect(flooded.status).toBe("failed")
    expect(flooded.reason).toContain("busy (429)")
    expect(web.count("flooded", "/")).toBe(3)

    const began = Date.now()
    const overloaded = await Effect.runPromise(
      ResearchReader.read({ url: web.url("overloaded", "/") }, reader(ResearchRate.make({ interval: 1 }))),
    )
    expect(overloaded.status).toBe("failed")
    expect(web.count("overloaded", "/")).toBe(1)
    expect(Date.now() - began).toBeLessThan(2_000)
  })

  test("calls a challenge page blocked by the site, and does not get around it", async () => {
    const page = await Effect.runPromise(
      ResearchReader.read({ url: web.url("challenged", "/") }, reader(ResearchRate.make({ interval: 1 }))),
    )
    expect(page.status).toBe("failed")
    expect(page.reason).toBe(ResearchRate.BLOCKED)
    expect(page.text).toBe("")
  })

  test("made no connection outside this computer", () => {
    expect(guard.outside()).toEqual([])
    expect(web.refused()).toEqual([])
  })
})
