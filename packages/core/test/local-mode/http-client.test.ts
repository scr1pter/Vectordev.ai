import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http"
import { EgressAttribution } from "../../src/local-mode/attribution"
import { Egress } from "../../src/local-mode/egress"
import { EgressGuard } from "../../src/local-mode/guard"
import { EgressHttpClient } from "../../src/local-mode/http-client"
import { LocalPolicy } from "../../src/local-mode/policy"
import { LocalProbe } from "../../src/local-mode/probe"
import { FakeWeb } from "../lib/fake-web"

const web = FakeWeb.start({
  sites: {
    catalog: {
      "/models": { body: "models" },
      "/moved": FakeWeb.redirect(302, (site) => site.url("denied", "/")),
    },
    denied: { "/": { body: "never" } },
  },
})
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request): Response =>
    new URL(request.url).pathname === "/moved"
      ? Response.redirect(`http://127.0.0.1:${model.port}/v1`, 302)
      : new Response("completion"),
})
const MODEL = `http://127.0.0.1:${model.port}`
const policy = LocalPolicy.resolve({
  global: {
    enabled: true,
    endpoints: [MODEL],
    web_domains: { deny: ["denied.web.test"] },
    allow: [{ source: "model-catalog", hosts: ["catalog.web.test"], reason: "Prices", added_at: 1, added_by: "app" }],
  },
})

// A request to the fake web goes through it as its proxy (Bun's fetch option), so no name is looked up.
const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  init: RequestInit = { proxy: web.origin } as RequestInit,
) =>
  effect.pipe(
    Effect.provide(EgressHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, init),
    Effect.runPromiseExit,
  )
const get = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get(url))
    return yield* response.text
  })
const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined
  const error = exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))[0]
  return HttpClientError.isHttpClientError(error) ? (error.reason as { cause?: unknown }).cause : error
}

const state: { handle?: EgressGuard.Handle } = {}
beforeAll(() => {
  state.handle = Egress.backstop()
})
afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await Egress.erase()
})
afterAll(async () => {
  state.handle?.uninstall()
  model.stop(true)
  await web.close()
})

describe("EgressHttpClient", () => {
  test("sends a labelled request as its source, attributed by the fiber, with nothing in its headers", async () => {
    Egress.configure(policy)
    const exit = await run(
      get(web.url("catalog", "/models")).pipe(
        EgressHttpClient.labelled("model-catalog"),
        Effect.provideService(EgressAttribution.Reference, { sessionID: "ses_v2", agent: "build" }),
      ),
    )
    expect(exit).toEqual(Exit.succeed("models"))
    expect(Egress.events().map((event) => [event.source, event.decision, event.session_id])).toEqual([
      ["model-catalog", "allow", "ses_v2"],
    ])
    const hit = web.hits().at(-1)!
    expect(Object.keys(hit.headers).filter((name) => name.startsWith("x-vector"))).toEqual([])
    expect(JSON.stringify(hit.headers)).not.toContain("ses_v2")
  })

  test("blocks an unlabelled request before it connects", async () => {
    Egress.configure(policy)
    const before = web.count("catalog")
    const exit = await run(get(web.url("catalog", "/models")))
    expect(failure(exit)).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(web.count("catalog")).toBe(before)
    expect(Egress.events().map((event) => [event.source, event.rule])).toEqual([["unlabelled", "unlabelled"]])
  })

  test("decides every redirect hop, and a model call follows none", async () => {
    Egress.configure(policy)
    const moved = await run(get(web.url("catalog", "/moved")).pipe(EgressHttpClient.labelled("model-catalog")))
    expect(String(failure(moved))).toContain("Vector Local blocked a connection to denied.web.test")
    expect(web.count("denied")).toBe(0)
    const inference = await run(get(`${MODEL}/moved`).pipe(EgressHttpClient.labelled("local-inference")), {})
    expect(String(failure(inference))).toContain("answered a model call with a redirect")
    expect(await run(get(`${MODEL}/v1`).pipe(EgressHttpClient.labelled("local-inference")), {})).toEqual(
      Exit.succeed("completion"),
    )
  })

  test("sends every hop through the caller's own fetch", async () => {
    Egress.configure(policy)
    const sent: string[] = []
    const own = ((input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(input instanceof Request ? input.url : String(input))
      return globalThis.fetch(input, init)
    }) as typeof globalThis.fetch
    const exit = await run(
      get(web.url("catalog", "/models")).pipe(
        EgressHttpClient.labelled("model-catalog"),
        Effect.provideService(FetchHttpClient.Fetch, own),
      ),
    )
    expect(exit).toEqual(Exit.succeed("models"))
    expect(sent).toEqual([web.url("catalog", "/models")])
  })

  test("decides a model call as one, whatever label the scope it is made in has", async () => {
    Egress.configure(policy)
    const before = web.count("catalog", "/models")
    const call = (url: string, scope?: string) =>
      Effect.gen(function* () {
        const client = EgressHttpClient.models(yield* HttpClient.HttpClient, LocalProbe.makeHolds())
        const response = yield* client.execute(HttpClientRequest.get(url))
        return yield* response.text
      }).pipe(
        scope ? EgressHttpClient.labelled(scope) : (effect) => effect,
        Effect.provide(FetchHttpClient.layer),
        Effect.runPromiseExit,
      )
    // Inside a web tool's scope a model call still goes only to a server on the list, decided as a model call.
    expect(await call(`${MODEL}/v1`, "webfetch")).toEqual(Exit.succeed("completion"))
    expect(failure(await call(web.url("catalog", "/models"), "webfetch"))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(failure(await call(web.url("catalog", "/models")))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(web.count("catalog", "/models")).toBe(before)
    expect(Egress.events().map((event) => [event.source, event.purpose, event.decision])).toEqual([
      ["local-inference", "inference", "allow"],
      ["local-inference", "inference", "block"],
      ["local-inference", "inference", "block"],
    ])
  })

  test("passes everything and logs nothing with Vector Local off", async () => {
    expect(await run(get(web.url("catalog", "/models")))).toEqual(Exit.succeed("models"))
    expect(Egress.events()).toEqual([])
  })
})
