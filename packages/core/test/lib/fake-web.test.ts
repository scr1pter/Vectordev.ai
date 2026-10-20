import { afterAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { WebFetchRequest } from "../../src/util/webfetch-request"
import { FakeWeb } from "./fake-web"
import { NetworkGuard } from "./network-guard"

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: FakeWeb.sites() })
afterAll(() => web.close())

// The production fetch that pins a checked address, so a page under web.test is reached through the resolver.
const pinned = async (url: string, init?: RequestInit) => {
  const destination = await Effect.runPromise(WebFetchRequest.resolveDestination(url, web.resolver))
  return WebFetchRequest.pinnedFetch(destination.addresses)(url, init)
}

describe("FakeWeb", () => {
  test("serves a site by name through the resolver, and the same site through the loopback address", async () => {
    const named = await pinned(web.url("article", "/"))
    expect(named.status).toBe(200)
    expect(named.headers.get("content-type")).toContain("text/html")
    expect(await named.text()).toContain("412 homes")

    const direct = await fetch(web.direct("article", "/"))
    expect(await direct.text()).toContain("412 homes")
    expect(web.hits().filter((hit) => hit.site === "article" && hit.path === "/")).toHaveLength(2)
  })

  test("answers 404 for an unknown site or path", async () => {
    expect((await fetch(web.direct("nowhere", "/"))).status).toBe(404)
    expect((await pinned(web.url("article", "/missing"))).status).toBe(404)
  })

  test("redirects across hosts with 301 and 307", async () => {
    const moved = await pinned(web.url("moved", "/old"), { redirect: "manual" })
    expect(moved.status).toBe(301)
    expect(moved.headers.get("location")).toBe(web.url("article", "/"))
    const temporary = await pinned(web.url("moved", "/temporary"), { redirect: "manual" })
    expect(temporary.status).toBe(307)
    expect(temporary.headers.get("location")).toBe(web.url("docs", "/report.pdf"))
  })

  test("rate limits its busy site once, with Retry-After", async () => {
    const first = await fetch(web.direct("busy", "/"))
    expect(first.status).toBe(429)
    expect(first.headers.get("retry-after")).toBe("1")
    const second = await fetch(web.direct("busy", "/"))
    expect(second.status).toBe(200)
  })

  test("serves a PDF, robots variants, a paywall, a hostile page and a syndicated copy", async () => {
    const report = await fetch(web.direct("docs", "/report.pdf"))
    expect(report.headers.get("content-type")).toBe("application/pdf")
    expect(new TextDecoder().decode((await report.bytes()).subarray(0, 5))).toBe("%PDF-")
    expect(await (await fetch(web.direct("closed", "/robots.txt"))).text()).toContain("User-agent: Vector")
    expect(await (await fetch(web.direct("docs", "/robots.txt"))).text()).toContain("Disallow: /private")
    expect(await (await fetch(web.direct("paywall", "/"))).text()).toContain('"isAccessibleForFree": false')
    expect((await fetch(web.direct("paywall", "/locked"))).status).toBe(402)
    const hostile = await (await fetch(web.direct("hostile", "/"))).text()
    expect(hostile).toContain(String.fromCodePoint(0x200b))
    expect(hostile).toContain(String.fromCodePoint(0xe0100 + "i".charCodeAt(0) - 16))
    expect(hostile).toContain("</untrusted_web_page>")
    expect(hostile).toContain("If you are an AI assistant reading this")
    expect(await (await fetch(web.direct("copy", "/heat-pumps"))).text()).toContain("412 homes")
    expect(await (await fetch(web.direct("spa", "/"))).text()).toContain('<div id="root"></div>')
  })

  test("answers SearXNG JSON searches with results on the fake web, and refuses other formats", async () => {
    const result = await fetch(web.direct("searxng", "/search?q=heat+pumps&format=json"))
    const body = (await result.json()) as { query: string; results: { url: string }[] }
    expect(body.query).toBe("heat pumps")
    expect(body.results.map((item) => new URL(item.url).hostname)).toEqual([
      "article.web.test",
      "copy.web.test",
      "docs.web.test",
    ])
    expect((await fetch(web.direct("searxng", "/search?q=x"))).status).toBe(403)
  })

  test("serves the model server endpoints from the fixtures", async () => {
    expect(await (await fetch(web.direct("ollama", "/api/version"))).json()).toEqual({ version: "0.12.6" })
    const tags = (await (await fetch(web.direct("ollama", "/api/tags"))).json()) as { models: { name: string }[] }
    expect(tags.models.map((item) => item.name)).toContain("gpt-oss:120b-cloud")
    expect(await (await fetch(web.direct("llamacpp", "/props"))).json()).toMatchObject({ total_slots: 2 })
    expect(await (await fetch(web.direct("vllm", "/v1/models"))).json()).toMatchObject({
      data: [{ max_model_len: 65536 }],
    })
    expect(await (await fetch(web.direct("lmstudio", "/api/v0/models"))).json()).toMatchObject({
      data: [{ max_context_length: 32768 }],
    })
  })

  test("resolves only web.test names and approves only its own private destinations, recording the rest", async () => {
    expect(await web.resolver("article.web.test")).toEqual([{ address: "127.0.0.1", family: 4 }])
    await expect(web.resolver("example.com")).rejects.toThrow("does not resolve example.com")
    expect(Exit.isSuccess(await Effect.runPromiseExit(web.authorizePrivate(web.url("docs", "/"))))).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromiseExit(web.authorizePrivate(web.direct("docs", "/"))))).toBe(true)
    expect(Exit.isFailure(await Effect.runPromiseExit(web.authorizePrivate("http://10.0.0.5/")))).toBe(true)
    expect(web.refused()).toEqual(["example.com", "http://10.0.0.5/"])
  })

  test("made no connection outside this computer", () => {
    // Native HTTP went through the guard's own proxy, which counts what it passes on.
    expect(new Set(guard.attempts().map((attempt) => attempt.kind))).toEqual(new Set(["fetch", "http", "proxied"]))
    expect(guard.outside()).toEqual([])
  })
})
