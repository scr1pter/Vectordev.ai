import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ResearchPaywall } from "../../src/research/paywall"
import { ResearchRate } from "../../src/research/rate"
import { ResearchReader } from "../../src/research/reader"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const long = `<p>${"The public part of the story goes on. ".repeat(60)}</p><p>${"Subscriber text that is not kept. ".repeat(80)}</p>`
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    metered: {
      "/": {
        headers: { "content-type": "text/html" },
        body: `<html><head><title>Metered</title></head><body><main><h1>Metered story</h1>${long}<div class="tp-modal">Subscribe</div></main></body></html>`,
      },
    },
    tiered: {
      "/": {
        headers: { "content-type": "text/html" },
        body: `<html><head><meta property="article:content_tier" content="locked" /><title>Locked</title></head><body><main>${long}</main></body></html>`,
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
const read = (url: string) =>
  Effect.runPromise(
    ResearchReader.read(
      { url },
      {
        http,
        authorize: () => Effect.void,
        authorizePrivate: web.authorizePrivate,
        resolver: web.resolver,
        publicNames: [FakeWeb.DOMAIN],
        limiter: ResearchRate.make({ interval: 1 }),
      },
    ),
  )

describe("ResearchPaywall", () => {
  test("knows 401, 402 and 403 as a wall", () => {
    expect([401, 402, 403, 404, 200].map(ResearchPaywall.status)).toEqual([true, true, true, false, false])
  })

  test("reads isAccessibleForFree: false anywhere in the structured data, as a value or a string", () => {
    expect(ResearchPaywall.marked({ html: "", structured: [{ isAccessibleForFree: false }] })).toBe("structured-data")
    expect(ResearchPaywall.marked({ html: "", structured: [{ isAccessibleForFree: "False" }] })).toBe("structured-data")
    expect(
      ResearchPaywall.marked({ html: "", structured: [{ "@graph": [{ hasPart: [{ isAccessibleForFree: false }] }] }] }),
    ).toBe("structured-data")
    expect(ResearchPaywall.marked({ html: "", structured: [{ isAccessibleForFree: true }] })).toBeUndefined()
  })

  test("reads the markers of metered and registration walls, and not the word alone", () => {
    expect(ResearchPaywall.marked({ html: '<div class="article paywall">', structured: [] })).toBe("meter")
    expect(ResearchPaywall.marked({ html: '<section id="regwall">', structured: [] })).toBe("meter")
    expect(ResearchPaywall.marked({ html: "<p>Why paywalls fail</p>", structured: [] })).toBeUndefined()
  })

  test("keeps a public excerpt that ends at a sentence or a line", () => {
    const text = `${"A sentence that is public. ".repeat(100)}`
    const excerpt = ResearchPaywall.excerpt(text)
    expect(excerpt.length).toBeLessThanOrEqual(ResearchPaywall.EXCERPT_CHARS)
    expect(excerpt.endsWith(".")).toBe(true)
    expect(ResearchPaywall.excerpt("Short.")).toBe("Short.")
  })
})

describe("paywalls on the fake web", () => {
  test("keeps the public excerpt of a page whose structured data says it is not free", async () => {
    const page = await read(web.url("paywall", "/"))
    expect(page).toMatchObject({ status: "paywalled", paywall: "structured-data", reason: ResearchPaywall.MESSAGE })
    expect(page.text).toContain("Compressor makers in three countries")
  })

  test("treats a 402 or a 403 as a wall", async () => {
    expect(await read(web.url("paywall", "/locked"))).toMatchObject({ status: "paywalled", paywall: "status" })
    expect(await read(web.url("paywall", "/members"))).toMatchObject({ status: "paywalled", paywall: "status" })
  })

  test("keeps only the excerpt of a metered or tiered page", async () => {
    const metered = await read(web.url("metered", "/"))
    expect(metered).toMatchObject({ status: "paywalled", paywall: "meter" })
    expect(metered.text.length).toBeLessThanOrEqual(ResearchPaywall.EXCERPT_CHARS)
    expect(metered.text).not.toContain("Subscriber text")
    expect((await read(web.url("tiered", "/"))).status).toBe("paywalled")
  })

  test("reads a free page in full", async () => {
    expect((await read(web.url("article", "/"))).paywall).toBeUndefined()
  })

  test("made no connection outside this computer", () => {
    expect(guard.outside()).toEqual([])
    expect(web.refused()).toEqual([])
  })
})
