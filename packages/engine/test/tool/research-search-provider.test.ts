import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { BROWSER, OPTIONS, options, paid, parsePaid, searchProvider } from "../../src/tool/research-search"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Where Deep research searches (section 5.7): the user's own SearXNG server, else Exa or Parallel on their own key
// (under Vector Local only when the user allowed them), else nothing. A search `vector run --research --search` names
// picks among those. Exa and Parallel get the query alone, and their answers are read for results with addresses.

const guard = NetworkGuard.use()
const SEARXNG = { search: { url: "https://searx.example.lan" } }

describe("research's search provider", () => {
  test("auto takes SearXNG, then Exa or Parallel, then none", () => {
    expect(searchProvider(SEARXNG, { exa: true, parallel: true })).toEqual({
      provider: "searxng",
      url: "https://searx.example.lan",
    })
    expect(searchProvider(undefined, { exa: true, parallel: true })).toEqual({ provider: "exa" })
    expect(searchProvider(undefined, { exa: false, parallel: true })).toEqual({ provider: "parallel" })
    expect(searchProvider(undefined)).toEqual({ provider: "none" })
  })

  test("under Vector Local, Exa and Parallel only when the user allowed them there", () => {
    expect(searchProvider(undefined, { exa: true, parallel: true, local: { allowed: [] } })).toEqual({
      provider: "none",
    })
    expect(searchProvider(undefined, { exa: true, parallel: true, local: { allowed: ["parallel"] } })).toEqual({
      provider: "parallel",
    })
    const named = searchProvider(
      { search: { provider: "exa" } },
      { exa: true, parallel: false, local: { allowed: [] } },
    )
    expect(named.provider).toBe("none")
    expect(named.provider === "none" ? named.reason : "").toContain("Vector Local keeps research's searches off Exa")
  })

  test("a named search that is not set up says why, and the browser is not built yet", () => {
    const exa = searchProvider({ search: { provider: "exa" } })
    expect(exa.provider === "none" ? exa.reason : "").toContain("no Exa key is set up")
    const searxng = searchProvider({ search: { provider: "searxng" } })
    expect(searxng.provider === "none" ? searxng.reason : "").toContain("no SearXNG address is set up")
    const browser = searchProvider({ search: { provider: "browser" }, browser_search: true })
    expect(browser).toEqual({ provider: "none", reason: BROWSER })
  })

  test("the command line's --search picks among what the user set up, and none searches nothing", () => {
    expect(searchProvider(SEARXNG, { exa: true, parallel: false }, "exa")).toEqual({ provider: "exa" })
    expect(searchProvider(SEARXNG, { exa: true, parallel: false }, "none")).toEqual({ provider: "none" })
    expect(searchProvider(SEARXNG, { exa: true, parallel: false }, "auto")).toEqual({
      provider: "searxng",
      url: "https://searx.example.lan",
    })
    // It never reaches a server the user's settings do not name.
    const parallel = searchProvider(SEARXNG, { exa: true, parallel: false }, "parallel")
    expect(parallel.provider).toBe("none")
  })

  test("the command line's choices are read from the newest message the user sent", () => {
    const user = (id: string, parts: SessionV1.Part[]): SessionV1.WithParts => ({
      info: { id, sessionID: "ses_options", role: "user", time: { created: 1 }, agent: "research" } as SessionV1.User,
      parts,
    })
    const text = (id: string, value: string, extra: Partial<SessionV1.TextPart> = {}) =>
      ({ id, sessionID: "ses_options", messageID: "msg", type: "text", text: value, ...extra }) as SessionV1.TextPart
    const sent = user("msg_1", [
      text("p1", "Research heat pumps"),
      text("p2", "Research settings", { synthetic: true, metadata: { [OPTIONS]: { search: "none", scope: "brain" } } }),
    ])
    // Vector's own follow-up (a judge's verdict) is not a message the user sent.
    const followup = user("msg_2", [text("p3", "<vector_research_verdict>", { synthetic: true })])
    expect(options([sent, followup])).toEqual({ search: "none", scope: "brain" })
    expect(options([sent, user("msg_3", [text("p4", "Now research the costs")])])).toEqual({})
    expect(
      options([user("msg_4", [text("p5", "x"), text("p6", "y", { metadata: { [OPTIONS]: { search: "google" } } })])]),
    ).toEqual({})
  })
})

describe("Exa and Parallel through research", () => {
  test("reads results from JSON, from text blocks and from bare addresses, each page once", () => {
    const json = JSON.stringify({
      results: [
        {
          url: "https://nature.com/a?utm_source=x",
          title: "A study",
          text: "Homes saved energy.",
          publishedDate: "2025-04-02T00:00:00Z",
        },
        { url: "https://nature.com/a", title: "The same study" },
        { url: "ftp://files.example.com/b", title: "Not the web" },
        { url: "https://parallel.example.org/c", title: "Excerpts", excerpts: ["One.", "Two."] },
      ],
    })
    expect(parsePaid(json)).toEqual([
      {
        url: "https://nature.com/a?utm_source=x",
        title: "A study",
        snippet: "Homes saved energy.",
        published: "2025-04-02",
      },
      { url: "https://parallel.example.org/c", title: "Excerpts", snippet: "One. Two." },
    ])
    const blocks = [
      "Title: Heat pumps in cold climates",
      "URL: https://example.org/heat-pumps",
      "Published Date: 2026-03-14",
      "Author: Mara Lindqvist",
      "Text: The study followed 412 homes through two winters.",
      "",
      "Title: A second page",
      "URL: https://example.com/second",
      "Text: More.",
    ].join("\n")
    expect(parsePaid(blocks)).toEqual([
      {
        url: "https://example.org/heat-pumps",
        title: "Heat pumps in cold climates",
        snippet: "The study followed 412 homes through two winters.",
        published: "2026-03-14",
      },
      { url: "https://example.com/second", title: "A second page", snippet: "More." },
    ])
    expect(parsePaid("See https://example.org/x and https://example.org/y.", 1)).toEqual([
      { url: "https://example.org/x", title: "example.org", snippet: "" },
    ])
  })

  for (const provider of ["exa", "parallel"] as const)
    test(`${provider} gets the query alone, with the site filter in it, on the user's key`, async () => {
      const bodies: string[] = []
      const headers: Headers[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          headers.push(request.headers)
          bodies.push(await request.text())
          return Response.json({
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ results: [{ url: "https://nature.com/study", title: "Study" }] }),
                },
              ],
            },
          })
        },
      })
      try {
        const answer = await Effect.runPromise(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient
            return yield* paid(
              HttpClient.mapRequest(http, (request) => HttpClientRequest.setUrl(request, server.url.href)),
              provider,
              { query: "heat pump savings", site: "nature.com", limit: 3 },
              `${provider}-test-key`,
            )
          }).pipe(Effect.provide(FetchHttpClient.layer)),
        )
        expect(answer).toEqual({
          type: "results",
          items: [{ url: "https://nature.com/study", title: "Study", snippet: "" }],
        })
        const body = JSON.parse(bodies[0] ?? "{}") as { params: { arguments: Record<string, unknown> } }
        expect(JSON.stringify(body.params.arguments)).toContain("heat pump savings site:nature.com")
        expect(Object.keys(body.params.arguments)).not.toContain("session_id")
        expect(Object.keys(body.params.arguments)).not.toContain("model_name")
        expect(headers[0]?.get(provider === "exa" ? "x-api-key" : "authorization")).toBe(
          provider === "exa" ? "exa-test-key" : "Bearer parallel-test-key",
        )
      } finally {
        await server.stop(true)
      }
      expect(guard.outside()).toEqual([])
    })

  test("a service that fails is an answer, not a failed call", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("down", { status: 503 }) })
    try {
      const answer = await Effect.runPromise(
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient
          return yield* paid(
            HttpClient.mapRequest(http, (request) => HttpClientRequest.setUrl(request, server.url.href)),
            "exa",
            { query: "heat pump savings" },
          )
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      )
      expect(answer.type).toBe("failed")
      expect(answer.type === "failed" ? answer.message : "").toContain("Exa did not answer the search")
    } finally {
      await server.stop(true)
    }
    expect(guard.outside()).toEqual([])
  })
})
