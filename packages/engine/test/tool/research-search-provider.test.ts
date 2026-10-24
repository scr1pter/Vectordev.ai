import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Global } from "@vectordevai/core/global"
import { Egress } from "@vectordevai/core/local-mode/egress"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { McpWebSearch } from "../../src/tool/mcp-websearch"
import {
  BROWSER,
  OPTIONS,
  PAID,
  UNDATED,
  options,
  paid,
  parsePaid,
  searchProvider,
} from "../../src/tool/research-search"
import { calls, output, plan, runtime, send, setup } from "../lib/research"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// Where Deep research searches (section 5.7): the user's own SearXNG server, else Exa or Parallel on their own key
// (under Vector Local only when the user allowed them), else nothing. A search `vector run --research --search` names
// picks among those. Exa and Parallel get the query alone, and their answers are read for results with addresses.

const guard = NetworkGuard.use()
const SEARXNG = { search: { url: "https://searx.example.lan" } }

// Exa on the fake web: what it was asked, and results that point back at the fake web's pages.
const asked: string[] = []
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    exa: {
      "/mcp": async (request, context) => {
        asked.push(await request.text())
        return Response.json({
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [
                    {
                      url: context.url("article", "/"),
                      title: "Heat pump field study",
                      text: "The study followed 412 homes.",
                    },
                  ],
                }),
              },
            ],
          },
        })
      },
    },
  },
})
afterAll(() => web.close())
// Every request goes out as it would, but Exa's address reaches the fake web instead.
const it = runtime(web, {
  http: Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return HttpClient.mapRequest(http, (request) =>
        request.url === McpWebSearch.EXA_URL ? HttpClientRequest.setUrl(request, web.direct("exa", "/mcp")) : request,
      )
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer)),
})

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
              { query: "heat pump savings", site: "nature.com", limit: 3, recency: "week" },
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
        // Neither filters by date: Parallel is asked for the period in its objective, and Exa gets the query alone.
        expect(body.params.arguments).toMatchObject(
          provider === "parallel"
            ? {
                objective: "heat pump savings site:nature.com (published in the past week)",
                search_queries: ["heat pump savings site:nature.com"],
              }
            : { query: "heat pump savings site:nature.com" },
        )
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

it.instance(
  "research_search through Exa: a private query is never sent, results are labelled billed and join provenance",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web, { research: { search: { provider: "exa" } } })
      const auth = yield* Auth.Service
      yield* auth.set("exa", new Auth.Api({ type: "api", key: "exa-test-key" }))
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Research",
        permission: [{ permission: "research_read", pattern: "*", action: "allow" }],
      })
      const sent = asked.length
      yield* test.llm.tool("research_plan", plan())
      // A query that copies a line of the owner's MEMORY.md is refused before it leaves.
      yield* test.llm.tool("research_search", { query: "I work at Hooli on the payments team in Lisbon" })
      yield* test.llm.tool("research_search", { query: "heat pump field study savings", recency: "year" })
      // A result's address, which the user never typed, is the run's to read.
      yield* test.llm.tool("research_read", { url: web.url("article", "/") })
      yield* test.llm.text("Done.")
      yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
      const [refused, searched] = yield* calls(session.id, "research_search")
      expect(refused?.state.status === "completed" ? refused.state.metadata.refused : undefined).toBe("outbound")
      expect(asked.slice(sent)).toHaveLength(1)
      expect(asked.slice(sent)[0]).toContain("heat pump field study savings")
      expect(asked.slice(sent)[0]).not.toContain("Hooli")
      expect(output(searched)).toContain(PAID.replaceAll("{name}", "Exa"))
      expect(output(searched)).toContain(UNDATED.replaceAll("{name}", "Exa").replace("{recency}", "year"))
      expect(output(searched)).toContain(web.url("article", "/"))
      const [read] = yield* calls(session.id, "research_read")
      expect(read?.state.status === "completed" ? read.state.metadata.refused : "error").toBeUndefined()
      expect(output(read)).toContain("S1")
      expect(guard.outside()).toEqual([])
    }),
  60_000,
)

it.instance(
  "with Vector Local on, research_search reaches Exa once the user allowed it there, decided and logged as Exa's",
  () =>
    Effect.gen(function* () {
      const test = yield* setup(web, { research: { search: { provider: "exa" } } })
      const auth = yield* Auth.Service
      yield* auth.set("exa", new Auth.Api({ type: "api", key: "exa-test-key" }))
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Research" })
      // Vector Local as the owner sets it in their own config, beside the research settings setup wrote there: the
      // fake LLM server is the one model server on the list, and Exa is a service they allowed.
      const file = path.join(Global.Path.config, "vector.json")
      const written = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(
        file,
        JSON.stringify({
          ...written,
          local: {
            enabled: true,
            endpoints: [new URL(test.llm.url).origin],
            web: "ask",
            allow: [{ source: "websearch-exa", reason: "Research searches", added_at: Date.now(), added_by: "app" }],
          },
        }),
      )
      Config.refreshLocal()
      Config.confirmLocal()
      yield* Effect.gen(function* () {
        const since = Date.now()
        const sent = asked.length
        yield* test.llm.tool("research_plan", plan())
        yield* test.llm.tool("research_search", { query: "heat pump field study savings" })
        yield* test.llm.text("Done.")
        yield* send({ sessionID: session.id, agent: "research", text: "Research how much heat pumps save." })
        const [searched] = yield* calls(session.id, "research_search")
        expect(output(searched)).toContain(PAID.replaceAll("{name}", "Exa"))
        expect(asked.slice(sent)).toHaveLength(1)
        const decided = Egress.events({ since })
          .filter((event) => event.source.startsWith("websearch-"))
          .map((event) => [event.source, event.decision, event.rule])
        expect(decided).toEqual([["websearch-exa", "allow", "allowed-source"]])
        expect(guard.outside()).toEqual([])
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            writeFileSync(file, JSON.stringify(written))
            Config.refreshLocal()
            rmSync(Config.localConfirmedFile(), { force: true })
            await Egress.erase()
          }),
        ),
      )
    }),
  60_000,
)
