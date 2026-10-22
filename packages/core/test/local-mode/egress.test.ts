import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { EgressAttribution } from "../../src/local-mode/attribution"
import { Egress } from "../../src/local-mode/egress"
import { EgressGuard } from "../../src/local-mode/guard"
import { LocalPolicy } from "../../src/local-mode/policy"
import { FakeWeb } from "../lib/fake-web"
import { tmpdir } from "../fixture/tmpdir"

// A documentation address (TEST-NET-2): never routed, so a guard that failed to block would hang, not reach anyone.
const OUTSIDE = "198.51.100.7"

const web = FakeWeb.start({
  sites: {
    catalog: { "/models": { body: "models" } },
    page: {
      "/": { body: "page" },
      "/out": FakeWeb.redirect(302, (site) => site.url("denied", "/")),
      "/same": FakeWeb.redirect(302, (site) => site.url("page", "/landed")),
      "/landed": { body: "landed" },
    },
    denied: { "/": { body: "never" } },
  },
})
// A model server on this computer that answers with a redirect.
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request): Response =>
    new URL(request.url).pathname === "/moved"
      ? Response.redirect(`http://127.0.0.1:${model.port}/v1`, 307)
      : new Response("completion"),
})
const MODEL = `http://127.0.0.1:${model.port}`
const on = (local: Parameters<typeof LocalPolicy.resolve>[0]["global"] = {}) =>
  LocalPolicy.resolve({
    global: {
      enabled: true,
      endpoints: [MODEL],
      web_domains: { deny: ["denied.web.test"] },
      allow: [{ source: "model-catalog", hosts: ["catalog.web.test"], reason: "Prices", added_at: 1, added_by: "app" }],
      ...local,
    },
  })
// The fake web answers as the proxy each request goes through, so no name is looked up.
const viaWeb = { proxy: web.origin }

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

describe("Egress.decide", () => {
  test("allows everything and logs nothing while Vector Local is off", () => {
    const decided = Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    expect(decided).toMatchObject({ decision: "allow", rule: "local-off", purpose: "catalog" })
    expect(decided.event).toBeUndefined()
    expect(Egress.events()).toEqual([])
  })

  test("decides each labelled request and logs where it went and why, never its path or query", () => {
    Egress.configure(on())
    const model = Egress.decide({
      source: "local-inference",
      url: `${MODEL}/v1/chat/completions?key=secret`,
      method: "post",
    })
    const catalog = Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    expect([model.decision, model.rule, catalog.decision, catalog.rule]).toEqual([
      "allow",
      "listed",
      "block",
      "vector-service",
    ])
    expect(Egress.events().map((event) => [event.source, event.origin, event.method, event.decision])).toEqual([
      ["local-inference", MODEL, "POST", "allow"],
      ["model-catalog", "https://vectordev.ai", "GET", "block"],
    ])
    expect(JSON.stringify(Egress.events())).not.toContain("secret")
    expect(JSON.stringify(Egress.events())).not.toContain("completions")
    // A source the registry does not have is a request no one labelled.
    expect(Egress.decide({ source: "no-such-source", url: "https://example.org/" })).toMatchObject({
      decision: "block",
      purpose: "unknown",
    })
  })

  test("answers one ask per one-time grant, and every ask after a standing one", () => {
    Egress.configure(on())
    const download = () =>
      Egress.decide({ source: "embedding-model", url: "https://huggingface.co/model.onnx" }).decision
    expect(download()).toBe("ask")
    Egress.grant("embedding-model", { once: true })
    expect([download(), download()]).toEqual(["allow", "ask"])
    Egress.grant("embedding-model", { once: false })
    expect([download(), download()]).toEqual(["allow", "allow"])
  })

  test("attributes each event to its session, and rolls helpers up into the session that launched them", () => {
    Egress.configure(on())
    const carried = { personal: 2, documents: 1, repository: 3 }
    EgressAttribution.run({ sessionID: "ses_root", agent: "build", carried }, () =>
      Egress.decide({ source: "local-inference", url: `${MODEL}/v1/chat/completions` }),
    )
    EgressAttribution.run({ sessionID: "ses_review", rootID: "ses_root", agent: "vectorscope.review" }, () => {
      Egress.decide({ source: "local-inference", url: `${MODEL}/v1/chat/completions` })
      Egress.decide({ source: "webfetch", url: "https://example.org/page" })
      Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    })
    expect(Egress.events({ session: "ses_review" }).map((event) => event.root_session_id)).toEqual([
      "ses_root",
      "ses_root",
      "ses_root",
    ])
    expect(Egress.summary("ses_root")).toEqual({
      requests: 4,
      helper_requests: 3,
      model_calls: { [MODEL]: 2 },
      pages: 1,
      hosts: 1,
      searches: 0,
      carried,
      blocked: { "model-catalog": 1 },
    })
    expect(Egress.summary("ses_other").requests).toBe(0)
    expect(Egress.summary().requests).toBe(4)
    expect(Egress.events({ blocked: true }).map((event) => event.source)).toEqual(["model-catalog"])
  })

  test("tells the user about unlabelled blocks and blocks they caused, once per source in ten minutes", () => {
    Egress.configure(on())
    const told: LocalMode.Event[] = []
    const all: LocalMode.Event[] = []
    const stop = Egress.notices((event) => told.push(event))
    const stopAll = Egress.subscribe((event) => all.push(event))
    const blocked = LocalPolicy.decide(on(), { purpose: "unknown", url: "https://example.org/", source: "unlabelled" })
    Egress.record({ source: "unlabelled", url: "https://example.org/" }, blocked)
    Egress.record({ source: "unlabelled", url: "https://example.net/" }, blocked)
    // An expected block is only listed.
    Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    Egress.decide({ source: "github", url: "https://github.com/", notify: true })
    stop()
    stopAll()
    expect(told.map((event) => [event.source, event.origin])).toEqual([
      ["unlabelled", "https://example.org"],
      ["github", "https://github.com"],
    ])
    expect(all).toHaveLength(4)
  })

  test("resolves the policy with the catalog's cloud hosts refused as a user's model servers", () => {
    const policy = Egress.resolve({
      global: { enabled: true, endpoints: ["https://api.newcloud.example", "http://127.0.0.1:11434"] },
      catalog: { newcloud: { api: "https://api.newcloud.example/v1" } },
    })
    expect(policy.endpoints).toEqual([{ origin: "http://127.0.0.1:11434", from: "user" }])
    expect(Egress.policy()).toBe(policy)
  })
})

describe("the network log on disk", () => {
  test("is written while Vector Local is on, exported, and erased", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "local")
    Egress.configure(on(), { log: { directory } })
    Egress.decide({ source: "local-inference", url: `${MODEL}/v1` })
    Egress.configure(LocalPolicy.OFF)
    Egress.decide({ source: "local-inference", url: `${MODEL}/v1` })
    const exported = await Egress.exported()
    expect(exported.map((event) => event.source)).toEqual(["local-inference"])
    const [file] = fs.readdirSync(directory)
    expect(fs.statSync(path.join(directory, file!)).mode & 0o777).toBe(0o600)
    await Egress.erase()
    expect(fs.readdirSync(directory)).toEqual([])
    expect(Egress.events()).toEqual([])
  })
})

describe("Egress.fetch under the backstop guard", () => {
  test("sends a labelled request the policy allows, and blocks the same host without a label", async () => {
    Egress.configure(on())
    const response = await Egress.fetch("model-catalog", web.url("catalog", "/models"), viaWeb)
    expect(await response.text()).toBe("models")
    await expect(fetch(web.url("catalog", "/models"), viaWeb as RequestInit)).rejects.toBeInstanceOf(
      EgressGuard.EgressBlocked,
    )
    await expect(fetch(web.url("catalog", "/models"))).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(web.count("catalog", "/models")).toBe(1)
    const unlabelled = Egress.events({ blocked: true })
    expect(unlabelled.map((event) => [event.source, event.purpose, event.rule])).toEqual([
      ["unlabelled", "unknown", "unlabelled"],
      ["unlabelled", "unknown", "unlabelled"],
    ])
    expect(unlabelled.every((event) => event.frame?.includes("egress.test.ts"))).toBe(true)
  })

  test("refuses what the policy blocks before anything connects", async () => {
    Egress.configure(on({ web: "none" }))
    const before = web.hits().length
    await expect(Egress.fetch("webfetch", web.url("page", "/"), viaWeb)).rejects.toThrow("Web access is set to None")
    await expect(Egress.fetch("model-catalog", `https://${OUTSIDE}/api`)).rejects.toBeInstanceOf(
      EgressGuard.EgressBlocked,
    )
    expect(web.hits().length).toBe(before)
  })

  test("does not let an inherited scope reach an unrelated host", async () => {
    Egress.configure(on())
    await EgressAttribution.run({ sessionID: "ses_1" }, () =>
      EgressAttribution.granted(
        { source: "model-catalog", purpose: "catalog", grants: [{ host: "catalog.web.test" }] },
        async () => {
          await expect(fetch(web.url("page", "/"), viaWeb as RequestInit)).rejects.toBeInstanceOf(
            EgressGuard.EgressBlocked,
          )
          // Its own host passes, but not through a proxy the scope was not granted.
          await expect(fetch(web.url("catalog", "/models"), viaWeb as RequestInit)).rejects.toThrow("It is a proxy")
        },
      ),
    )
    expect(web.count("page")).toBe(0)
  })

  test("decides every redirect hop, and stops at one the policy blocks", async () => {
    Egress.configure(on())
    await expect(Egress.fetch("webfetch", web.url("page", "/out"), viaWeb)).rejects.toThrow("never reaches")
    expect(web.count("denied")).toBe(0)
    const followed = await Egress.fetch("webfetch", web.url("page", "/same"), viaWeb)
    expect({ text: await followed.text(), redirected: followed.redirected }).toEqual({
      text: "landed",
      redirected: true,
    })
    expect(Egress.events().map((event) => [event.source, event.decision, event.rule])).toEqual([
      ["webfetch", "allow", "web-ask"],
      ["webfetch", "block", "web-deny"],
      ["webfetch", "allow", "web-ask"],
      ["webfetch", "allow", "web-ask"],
    ])
    // A caller that follows redirects itself gets the redirect.
    const manual = await Egress.fetch("webfetch", web.url("page", "/out"), { ...viaWeb, redirect: "manual" })
    expect(manual.status).toBe(302)
  })

  test("never follows a redirect on a model call", async () => {
    Egress.configure(on())
    await expect(Egress.fetch("local-inference", `${MODEL}/moved`, { method: "POST", body: "{}" })).rejects.toThrow(
      "answered a model call with a redirect",
    )
    expect(await (await Egress.fetch("local-inference", `${MODEL}/v1`)).text()).toBe("completion")
  })

  test("carries who a request is for in context, never in a header", async () => {
    Egress.configure(on())
    const carried = { personal: 3, documents: 1, repository: 0 }
    await EgressAttribution.run({ sessionID: "ses_child", rootID: "ses_parent", agent: "build", carried }, () =>
      Egress.fetch("model-catalog", web.url("catalog", "/models"), viaWeb),
    )
    const hit = web.hits().at(-1)!
    expect(Object.keys(hit.headers).filter((name) => name.toLowerCase().startsWith("x-vector"))).toEqual([])
    expect(JSON.stringify(hit.headers)).not.toContain("ses_")
    expect(Egress.events().at(-1)).toMatchObject({
      session_id: "ses_child",
      root_session_id: "ses_parent",
      carried,
    })
  })

  test("passes straight through with Vector Local off", async () => {
    const response = await Egress.fetch("webfetch", web.url("page", "/"), viaWeb)
    expect(await response.text()).toBe("page")
    expect(Egress.events()).toEqual([])
  })
})
