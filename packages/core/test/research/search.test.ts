import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ResearchSearch } from "../../src/research/search"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A SearXNG server whose settings leave the json format off: it answers every search 403.
    searxoff: { "/search": { status: 403, headers: { "content-type": "text/html" }, body: "<h1>403 Forbidden</h1>" } },
    // A server that answers with a page rather than SearXNG's JSON.
    searxhtml: { "/search": { headers: { "content-type": "text/html" }, body: "<html><body>Results</body></html>" } },
    searxbusy: { "/search": { status: 429, headers: { "content-type": "text/plain" }, body: "Too many requests" } },
    // A server under a path, as SearXNG often is behind a reverse proxy.
    proxied: {
      "/searx/search": (request, context) => {
        const query = new URL(request.url).searchParams
        return Response.json({
          results: [{ url: context.url("article", "/"), title: query.get("q"), content: query.get("time_range") }],
        })
      },
    },
    // A search server that sends the search on to a host outside the fake web.
    away: { "/search": FakeWeb.redirect(307, () => "https://search.example.com/search?q=heat") },
  },
})
afterAll(() => web.close())
const http = Effect.runSync(
  Effect.gen(function* () {
    return yield* HttpClient.HttpClient
  }).pipe(Effect.provide(FetchHttpClient.layer)),
)

const search = (site: string, query: ResearchSearch.Query, authorize: (url: string) => Effect.Effect<void, unknown>) =>
  Effect.runPromiseExit(
    ResearchSearch.searxng(query, {
      http,
      url: web.url(site, "/"),
      authorize,
      authorizePrivate: web.authorizePrivate,
      resolver: web.resolver,
    }),
  )

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the search to fail")
  return exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))[0]
}

describe("ResearchSearch.parseSearxng", () => {
  test("reads results from SearXNG's JSON answer, each page once by its canonical form", () => {
    const results = ResearchSearch.parseSearxng(
      JSON.stringify({
        query: "heat pumps",
        number_of_results: 4,
        results: [
          {
            url: "https://example.com/study?utm_source=searx&b=2&a=1",
            title: "Heat pump field study",
            content: "A field study of 412 homes.",
            engine: "duckduckgo",
            publishedDate: "2026-03-14T08:00:00",
          },
          { url: "https://EXAMPLE.com/study?a=1&b=2#results", title: "The same study again", content: "Copy" },
          { url: "https://example.org/report.pdf", title: null, content: null, publishedDate: null, engine: null },
        ],
        answers: [],
        infoboxes: [],
      }),
    )
    expect(results).toEqual([
      {
        url: "https://example.com/study?utm_source=searx&b=2&a=1",
        title: "Heat pump field study",
        snippet: "A field study of 412 homes.",
        published: "2026-03-14",
        engine: "duckduckgo",
      },
      { url: "https://example.org/report.pdf", title: "example.org", snippet: "" },
    ])
  })

  test("leaves out addresses that are not http or https and results it cannot read", () => {
    const results = ResearchSearch.parseSearxng(
      JSON.stringify({
        results: [
          { url: "javascript:alert(1)", title: "Script" },
          { url: "file:///etc/passwd", title: "File" },
          { url: "https://user:secret@example.com/", title: "Credentials" },
          { title: "No address" },
          { url: 42, title: "Number" },
          "not a result",
          null,
          { url: "not a url", title: "Broken" },
          { url: "https://example.net/kept", title: "Kept", publishedDate: "not a date" },
        ],
      }),
    )
    expect(results).toEqual([{ url: "https://example.net/kept", title: "Kept", snippet: "" }])
  })

  test("cleans hidden characters out of titles and snippets and cuts them to length", () => {
    const hidden = String.fromCodePoint(0x200b)
    const results = ResearchSearch.parseSearxng(
      JSON.stringify({
        results: [
          {
            url: "https://example.com/a",
            title: `Heat${hidden} pumps\n\n  in   winter`,
            content: "word ".repeat(400),
            engine: "e".repeat(80),
          },
        ],
      }),
    )
    expect(results[0]?.title).toBe("Heat pumps in winter")
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(500)
    expect(results[0]?.snippet.endsWith("…")).toBe(true)
    expect(results[0]?.engine?.length).toBeLessThanOrEqual(40)
  })

  test("keeps the asked number of results, at least 1 and at most 20", () => {
    const answer = JSON.stringify({
      results: Array.from({ length: 30 }, (_, index) => ({ url: `https://example.com/${index}`, title: `R${index}` })),
    })
    expect(ResearchSearch.parseSearxng(answer)).toHaveLength(ResearchSearch.DEFAULT_RESULTS)
    expect(ResearchSearch.parseSearxng(answer, 3)).toHaveLength(3)
    expect(ResearchSearch.parseSearxng(answer, 0)).toHaveLength(1)
    expect(ResearchSearch.parseSearxng(answer, 100)).toHaveLength(ResearchSearch.MAX_RESULTS)
  })

  test("gives no results for an answer that is not SearXNG's JSON", () => {
    expect(ResearchSearch.parseSearxng("<html>Results</html>")).toEqual([])
    expect(ResearchSearch.parseSearxng("")).toEqual([])
    expect(ResearchSearch.parseSearxng(JSON.stringify({ query: "x" }))).toEqual([])
    expect(ResearchSearch.parseSearxng(JSON.stringify({ results: "none" }))).toEqual([])
  })
})

describe("ResearchSearch.searxngUrl", () => {
  test("asks the server's JSON search, under the path it is served from", () => {
    expect(ResearchSearch.searxngUrl("https://searx.example.lan", { query: "heat pumps" })).toBe(
      "https://searx.example.lan/search?q=heat+pumps&format=json",
    )
    expect(
      ResearchSearch.searxngUrl("https://example.lan/searx/?token=x#top", {
        query: "heat pumps",
        site: "nature.com",
        recency: "year",
      }),
    ).toBe("https://example.lan/searx/search?q=heat+pumps+site%3Anature.com&format=json&time_range=year")
  })
})

describe("ResearchSearch.order", () => {
  test("auto takes SearXNG, then Exa or Parallel, then the browser, and always ends with none", () => {
    expect(
      ResearchSearch.order({ provider: "auto", searxng: "https://searx.example.lan", exa: true, parallel: true }),
    ).toEqual(["searxng", "exa", "parallel", "none"])
    expect(ResearchSearch.order({ provider: "auto", exa: false, parallel: true, browser: true })).toEqual([
      "parallel",
      "browser",
      "none",
    ])
    expect(ResearchSearch.order({ provider: "auto", exa: false, parallel: false })).toEqual(["none"])
  })

  test("under Vector Local, Exa and Parallel are used only when the user allowed them", () => {
    expect(
      ResearchSearch.order({ provider: "auto", exa: true, parallel: true, local: { allowed: [] } }),
    ).toEqual(["none"])
    expect(
      ResearchSearch.order({ provider: "auto", exa: true, parallel: true, local: { allowed: ["exa"] } }),
    ).toEqual(["exa", "none"])
    expect(ResearchSearch.order({ provider: "parallel", exa: false, parallel: true, local: { allowed: [] } })).toEqual(
      ["none"],
    )
  })

  test("a chosen provider that is not set up falls back to none", () => {
    expect(ResearchSearch.order({ provider: "searxng", exa: true, parallel: true })).toEqual(["none"])
    expect(ResearchSearch.order({ provider: "browser", exa: false, parallel: false })).toEqual(["none"])
    expect(ResearchSearch.order({ provider: "exa", exa: true, parallel: false })).toEqual(["exa", "none"])
    expect(ResearchSearch.order({ provider: "none", searxng: "https://x.lan", exa: true, parallel: true })).toEqual([
      "none",
    ])
  })

  test("says what a paid service sees under Vector Local", () => {
    expect(ResearchSearch.provided("exa")).toBe("Exa sees your search queries; billed by Exa on your key")
    expect(ResearchSearch.provided("parallel")).toBe("Parallel sees your search queries; billed by Parallel on your key")
  })
})

describe("ResearchSearch.searxng", () => {
  test("searches a SearXNG server through the web request guards", async () => {
    const authorized: string[] = []
    const exit = await search("searxng", { query: "heat pumps" }, (url) =>
      Effect.sync(() => {
        authorized.push(url)
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value.map((result) => result.url)).toEqual([
      web.url("article", "/"),
      web.url("copy", "/heat-pumps"),
      web.url("docs", "/report.pdf"),
    ])
    expect(exit.value[0]).toMatchObject({ published: "2026-03-14", engine: "fake" })
    expect(authorized).toEqual([web.url("searxng", "/search?q=heat+pumps&format=json")])
    const hit = web.hits().findLast((entry) => entry.site === "searxng")
    expect(hit?.headers.accept).toBe("application/json")
    expect(web.refused()).toEqual([])
    expect(guard.outside()).toEqual([])
  })

  test("passes the site and time range on, under the server's own path", async () => {
    const exit = await Effect.runPromiseExit(
      ResearchSearch.searxng(
        { query: "heat pumps", site: "nature.com", recency: "month" },
        {
          http,
          url: web.url("proxied", "/searx"),
          authorize: () => Effect.void,
          authorizePrivate: web.authorizePrivate,
          resolver: web.resolver,
        },
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    expect(exit.value).toEqual([
      { url: web.url("article", "/"), title: "heat pumps site:nature.com", snippet: "month" },
    ])
  })

  test("says how to turn on the json format when the server refuses it", async () => {
    expect(failure(await search("searxoff", { query: "heat pumps" }, () => Effect.void))).toMatchObject({
      message: ResearchSearch.JSON_OFF,
    })
    expect(failure(await search("searxhtml", { query: "heat pumps" }, () => Effect.void))).toMatchObject({
      message: ResearchSearch.JSON_OFF,
    })
  })

  test("says when the server is limiting searches", async () => {
    expect(failure(await search("searxbusy", { query: "heat pumps" }, () => Effect.void))).toMatchObject({
      message: ResearchSearch.BUSY,
    })
  })

  test("passes the caller's refusal on unchanged and sends nothing", async () => {
    const before = web.count("searxng")
    const refusal = new Error("Web access is set to None")
    expect(failure(await search("searxng", { query: "heat pumps" }, () => Effect.fail(refusal)))).toBe(refusal)
    expect(web.count("searxng")).toBe(before)
  })

  test("decides a redirect off the server again before following it", async () => {
    const authorized: string[] = []
    const refusal = new Error("That host is not on the list")
    const exit = await search("away", { query: "heat" }, (url) =>
      Effect.suspend(() => {
        authorized.push(url)
        return url.startsWith("https://search.example.com") ? Effect.fail(refusal) : Effect.void
      }),
    )
    expect(failure(exit)).toBe(refusal)
    expect(authorized).toEqual([web.url("away", "/search?q=heat&format=json"), "https://search.example.com/search?q=heat"])
    expect(web.refused()).toEqual([])
    expect(guard.outside()).toEqual([])
  })

  test("asks before a server on the user's own network, and refuses it without the ask", async () => {
    const asked: string[] = []
    const allowed = await Effect.runPromiseExit(
      ResearchSearch.searxng(
        { query: "heat pumps" },
        {
          http,
          url: web.url("searxng", "/"),
          authorize: () => Effect.void,
          authorizePrivate: (url) =>
            Effect.sync(() => {
              asked.push(url)
            }),
          resolver: web.resolver,
        },
      ),
    )
    expect(Exit.isSuccess(allowed)).toBe(true)
    expect(asked).toEqual([web.url("searxng", "/search?q=heat+pumps&format=json")])
    const before = web.count("searxng")
    const refused = await Effect.runPromiseExit(
      ResearchSearch.searxng(
        { query: "heat pumps" },
        { http, url: web.url("searxng", "/"), authorize: () => Effect.void, resolver: web.resolver },
      ),
    )
    expect(failure(refused)).toMatchObject({ _tag: "ResearchSearchFailed" })
    expect(web.count("searxng")).toBe(before)
  })
})
