import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ResearchRate } from "../../src/research/rate"
import { ResearchReader } from "../../src/research/reader"
import { ResearchRobots } from "../../src/research/robots"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A robots.txt that sends Vector to another site is not followed there.
    elsewhere: {
      "/": FakeWeb.html("article.html"),
      "/robots.txt": FakeWeb.redirect(302, (context) => context.url("docs", "/robots.txt")),
    },
    broken: {
      "/": FakeWeb.html("article.html"),
      "/robots.txt": { status: 500, body: "oops" },
    },
  },
})
afterAll(() => web.close())
const http = Effect.runSync(
  Effect.gen(function* () {
    return yield* HttpClient.HttpClient
  }).pipe(Effect.provide(FetchHttpClient.layer)),
)

const rules = (text: string) => ResearchRobots.parse(text)
const allowed = (text: string, path: string) => ResearchRobots.allowed(rules(text), `https://example.com${path}`)

describe("ResearchRobots.parse and allowed", () => {
  test("uses the Vector group when there is one, else the * group", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: Vector\nDisallow: /private\n"
    expect(allowed(text, "/public")).toBe(true)
    expect(allowed(text, "/private/a")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /private\n", "/private")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /private\n", "/open")).toBe(true)
  })

  test("matches the product token without case or version, and no other bot's name", () => {
    expect(allowed("User-agent: vector/1.99\nDisallow: /\n", "/a")).toBe(false)
    expect(allowed("User-agent: VECTOR\nDisallow: /\n", "/a")).toBe(false)
    expect(allowed("User-agent: VectorBot\nDisallow: /\nUser-agent: *\nAllow: /\n", "/a")).toBe(true)
  })

  test("lets consecutive user-agent lines share a group", () => {
    const text = "User-agent: Googlebot\nUser-agent: Vector\nDisallow: /shared\n\nUser-agent: *\nDisallow: /\n"
    expect(allowed(text, "/shared/x")).toBe(false)
    expect(allowed(text, "/other")).toBe(true)
  })

  test("lets the longest matching rule win, and an allow win a tie", () => {
    const text = "User-agent: *\nDisallow: /docs\nAllow: /docs/public\nDisallow: /same\nAllow: /same\n"
    expect(allowed(text, "/docs/secret")).toBe(false)
    expect(allowed(text, "/docs/public/a")).toBe(true)
    expect(allowed(text, "/same")).toBe(true)
  })

  test("reads * as any run of characters and a final $ as the end", () => {
    const text = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=\nAllow: /$\nDisallow: /\n"
    expect(allowed(text, "/")).toBe(true)
    expect(allowed(text, "/paper.pdf")).toBe(false)
    expect(allowed(text, "/paper.pdf?x=1")).toBe(false)
    expect(allowed(text, "/search?lang=en&q=heat")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /*.pdf$\n", "/paper.pdf.html")).toBe(true)
  })

  test("treats an empty Disallow as no rule, ignores comments, and always allows robots.txt itself", () => {
    expect(allowed("User-agent: *\nDisallow:\n", "/a")).toBe(true)
    expect(allowed("User-agent: * # everyone\nDisallow: /a # not this\n", "/a/b")).toBe(false)
    expect(allowed("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true)
  })

  test("compares percent-encoding without case", () => {
    expect(allowed("User-agent: *\nDisallow: /a%2fb\n", "/a%2Fb")).toBe(false)
  })
})

describe("ResearchRobots.rulesOf", () => {
  test("allows everything for a missing file, and nothing for a server error or no answer", () => {
    expect(ResearchRobots.rulesOf({ status: 404, text: "" })).toEqual({ type: "all" })
    expect(ResearchRobots.rulesOf({ status: 503, text: "" })).toEqual({ type: "none" })
    expect(ResearchRobots.rulesOf({ status: "unreachable" })).toEqual({ type: "none" })
    expect(ResearchRobots.rulesOf({ status: 200, text: "# nothing here\n" })).toEqual({ type: "all" })
    const read = ResearchRobots.rulesOf({ status: 200, text: "User-agent: *\nDisallow: /a\n" })
    expect(ResearchRobots.allowed(read, "https://example.com/a")).toBe(false)
  })
})

describe("ResearchRobots.cache", () => {
  test("asks each origin once per day, and skips the file for an address the user typed", async () => {
    const loads: string[] = []
    const cache = ResearchRobots.cache((address) =>
      Effect.sync(() => {
        loads.push(address)
        return { status: 200, text: "User-agent: *\nDisallow: /private\n" }
      }),
    )
    expect(await Effect.runPromise(cache.check("https://example.com/open"))).toBe(true)
    expect(await Effect.runPromise(cache.check("https://example.com/private/a"))).toBe(false)
    expect(await Effect.runPromise(cache.check("https://example.com/private/a", { typed: true }))).toBe(true)
    expect(loads).toEqual(["https://example.com/robots.txt"])
  })

  test("asks again once the day is over", async () => {
    const loads: string[] = []
    const cache = ResearchRobots.cache(
      (address) =>
        Effect.sync(() => {
          loads.push(address)
          return { status: 404, text: "" }
        }),
      0,
    )
    await Effect.runPromise(cache.check("https://example.com/a"))
    await Effect.runPromise(cache.check("https://example.com/b"))
    expect(loads).toHaveLength(2)
  })
})

describe("robots.txt on the fake web", () => {
  const options = () => ({
    http,
    authorize: () => Effect.void,
    authorizePrivate: web.authorizePrivate,
    resolver: web.resolver,
    limiter: ResearchRate.make({ interval: 1 }),
    robots: ResearchReader.robots({ http, authorizePrivate: web.authorizePrivate, resolver: web.resolver }),
  })

  test("skips a page whose robots.txt asks Vector not to read it", async () => {
    const before = web.count("closed", "/")
    const page = await Effect.runPromise(ResearchReader.read({ url: web.url("closed", "/") }, options()))
    expect(page.status).toBe("robots")
    expect(page.reason).toBe(ResearchReader.ROBOTS)
    expect(page.text).toBe("")
    // The page itself was never asked for.
    expect(web.count("closed", "/")).toBe(before)
    expect(web.count("closed", "/robots.txt")).toBeGreaterThan(0)
  })

  test("reads a page the * group allows, and skips the paths it does not", async () => {
    const reader = options()
    const pdf = await Effect.runPromise(ResearchReader.read({ url: web.url("docs", "/report.pdf") }, reader))
    expect(pdf.status).toBe("read")
    const notes = await Effect.runPromise(ResearchReader.read({ url: web.url("docs", "/private/notes") }, reader))
    expect(notes.status).toBe("robots")
    expect(web.count("docs", "/private/notes")).toBe(0)
  })

  test("reads a page the user pasted whatever robots.txt says", async () => {
    const page = await Effect.runPromise(ResearchReader.read({ url: web.url("closed", "/"), typed: true }, options()))
    expect(page.status).toBe("read")
    expect(page.text).toContain("412 homes")
  })

  test("applies robots.txt again on every redirect hop", async () => {
    const page = await Effect.runPromise(ResearchReader.read({ url: web.url("moved", "/temporary") }, options()))
    // moved has no robots.txt (404, allow all); the hop to docs reads docs' file, which allows the report.
    expect(page.status).toBe("read")
    expect(web.count("moved", "/robots.txt")).toBeGreaterThan(0)
    expect(web.count("docs", "/robots.txt")).toBeGreaterThan(0)
  })

  test("does not follow robots.txt to another site, and reads nothing from a site whose file errors", async () => {
    const docs = web.count("docs", "/robots.txt")
    const away = await Effect.runPromise(ResearchReader.read({ url: web.url("elsewhere", "/") }, options()))
    expect(away.status).toBe("robots")
    expect(web.count("docs", "/robots.txt")).toBe(docs)
    const broken = await Effect.runPromise(ResearchReader.read({ url: web.url("broken", "/") }, options()))
    expect(broken.status).toBe("robots")
    expect(web.count("broken", "/")).toBe(0)
  })

  test("made no connection outside this computer", () => {
    expect(guard.outside()).toEqual([])
    expect(web.refused()).toEqual([])
  })
})
