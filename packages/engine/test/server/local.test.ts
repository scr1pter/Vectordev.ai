import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parse } from "jsonc-parser"
import { Flag } from "@vectordevai/core/flag/flag"
import { Global } from "@vectordevai/core/global"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalSources } from "@vectordevai/core/local-mode/sources"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Config } from "../../src/config/config"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { LocalServers } from "../../../core/test/fixture/local-servers/serve"

// The Local API over a real listener with an owner and an invited guest: every /local route is the owner's, a change
// that loosens Vector Local needs `confirm` and writes nothing without it, a held change applies only as the owner saw
// it, a Vector the agent started cannot loosen it, and the network log, Find servers, Check and grants work as the app
// and the terminal UI use them. Nothing leaves this computer: the guard is strict and every model server is a fake one
// on 127.0.0.1. Each test starts from Vector Local off, with no local block in the user's config.

const guard = NetworkGuard.use()

const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

const GLOBAL_FILES = ["config.json", "vector.json", "vector.jsonc"].map((file) => path.join(Global.Path.config, file))

// The user's global config without a local block or providers, and Vector Local off with nothing held or logged.
afterEach(async () => {
  delete process.env[ChildEnvironment.AGENT_MARKER]
  GLOBAL_FILES.filter((file) => existsSync(file)).forEach((file) => {
    const value = parse(readFileSync(file, "utf8")) as Record<string, unknown>
    delete value.local
    delete value.provider
    writeFileSync(file, JSON.stringify(value, null, 2))
  })
  Config.refreshLocal()
  Config.confirmLocal()
  rmSync(Config.localConfirmedFile(), { force: true })
  await Egress.erase()
  await disposeAllInstances()
})

const at = (route: string) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", shared.path)
  return url
}
// A listener reused across tests: a pooled keep-alive socket could carry one test's request into another's.
const call = (route: string, init: RequestInit = {}) => fetch(at(route), { ...init, keepalive: false })
const send = (method: string, route: string, body?: unknown, headers: Record<string, string> = owner) =>
  call(route, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const json = async (response: Response) => (await response.json()) as any
const patch = (body: unknown) => send("PATCH", "/local", body)
// The user's local block as the global config file holds it.
const written = () =>
  GLOBAL_FILES.filter((file) => existsSync(file))
    .map((file) => (parse(readFileSync(file, "utf8")) as { local?: Record<string, unknown> }).local)
    .find((block) => block !== undefined)

// Turns Vector Local on through the API, as `vector local on` or the switch does.
const turnOn = async (extra: Record<string, unknown> = {}) => {
  const response = await patch({ enabled: true, ...extra, confirm: true })
  expect(response.status).toBe(200)
  return json(response)
}

describe("the Local API", () => {
  test("every /local route is the owner's own: an invited guest gets 403 on each", async () => {
    // The guest may use this workspace (a session list answers), so each 403 below is the owner-only gate itself.
    expect((await call("/session", { headers: guest })).status).toBe(200)
    const routes: (readonly [string, string, unknown?])[] = [
      ["GET", "/local"],
      ["PATCH", "/local", { enabled: true }],
      ["GET", "/local/egress"],
      ["GET", "/local/egress/summary"],
      ["GET", "/local/egress/export"],
      ["DELETE", "/local/egress"],
      ["POST", "/local/egress/report", { events: [] }],
      ["POST", "/local/detect", {}],
      ["POST", "/local/probe", { url: "http://127.0.0.1:9" }],
      ["POST", "/local/servers", { url: "http://127.0.0.1:9" }],
      ["POST", "/local/check", {}],
      ["POST", "/local/grant", { source: "embedding-model" }],
      ["GET", "/local/recommend"],
    ]
    for (const [method, route, body] of routes) {
      const response = await send(method, route, body, guest)
      expect([method, route, response.status]).toEqual([method, route, 403])
    }
    // The guest's PATCH changed nothing, and the owner reads every route.
    expect(Config.local().enabled).toBe(false)
    expect(written()).toBeUndefined()
    expect((await send("GET", "/local")).status).toBe(200)
  })

  test("a change that tightens applies at once; turning Vector Local off needs confirm and writes nothing without it", async () => {
    const on = await patch({ enabled: true })
    expect(on.status).toBe(200)
    expect((await json(on)).policy.enabled).toBe(true)
    expect(Config.local().enabled).toBe(true)

    const refused = await patch({ enabled: false })
    expect(refused.status).toBe(409)
    expect(await json(refused)).toMatchObject({
      name: "LocalConfirmError",
      data: { message: "This change would loosen Vector Local. Apply it?", changes: ["turns Vector Local off"] },
    })
    expect(Config.local().enabled).toBe(true)
    expect(written()?.enabled).toBe(true)

    const off = await patch({ enabled: false, confirm: true })
    expect(off.status).toBe(200)
    expect((await json(off)).policy.enabled).toBe(false)
    expect(Config.local().enabled).toBe(false)
    expect(written()?.enabled).toBe(false)
    expect(Config.localPending()).toBeUndefined()
  })

  test("a new model server, an allowed service or a looser Web access each need confirm; removing one does not", async () => {
    await turnOn({ web: "network" })
    const server = await patch({ endpoints: { add: ["http://127.0.0.1:11434/v1"] } })
    expect(server.status).toBe(409)
    expect((await json(server)).data.changes).toEqual(["adds the model server http://127.0.0.1:11434"])
    expect(Config.local().endpoints).toEqual([])

    const listed = await json(await patch({ endpoints: { add: ["http://127.0.0.1:11434/v1"] }, confirm: true }))
    expect(listed.policy.endpoints).toEqual([{ origin: "http://127.0.0.1:11434", from: "user" }])
    expect(written()?.endpoints).toEqual(["http://127.0.0.1:11434"])

    const allow = await patch({ allow: { add: [{ source: "github", reason: "Pull requests" }] } })
    expect(allow.status).toBe(409)
    expect((await json(allow)).data.changes).toEqual(["allows github"])
    const allowed = await json(
      await patch({ allow: { add: [{ source: "github", reason: " Pull requests " }] }, confirm: true }),
    )
    expect(allowed.policy.allow).toEqual([
      { source: "github", reason: "Pull requests", added_at: expect.any(Number), added_by: "app" },
    ])

    const looser = await patch({ web: "ask" })
    expect(looser.status).toBe(409)
    expect((await json(looser)).data.changes).toEqual(["sets Web access to Ask"])

    // Each of these only tightens, so none asks.
    expect((await patch({ web: "none" })).status).toBe(200)
    expect((await patch({ allow: { remove: ["github"] } })).status).toBe(200)
    const removed = await json(await patch({ endpoints: { remove: ["http://127.0.0.1:11434"] } }))
    expect(removed.policy).toMatchObject({ enabled: true, web: "none", endpoints: [], allow: [] })
  })

  test("refuses what Vector Local never lets through, and addresses that are not a model server's", async () => {
    await turnOn()
    const cases: (readonly [unknown, string])[] = [
      [{ allow: { add: [{ source: "cloud-inference", reason: "Faster" }] } }, "keeps it off"],
      [{ allow: { add: [{ source: "no-such-source", reason: "Why not" }] } }, "no service called no-such-source"],
      [{ allow: { add: [{ source: "github", reason: "  " }] } }, "Say why you allow github"],
      [{ endpoints: { add: ["http://user:secret@127.0.0.1:8000"] } }, "no user name or password"],
      [{ endpoints: { add: ["https://api.openai.com/v1"] } }, "api.openai.com"],
      [{ web_domains: { allow: { add: ["https://docs.example.com/path"] } } }, "is not a site name"],
    ]
    for (const [body, message] of cases) {
      const response = await patch({ ...(body as object), confirm: true })
      const answer = await json(response)
      expect([response.status, answer.name, answer.data.code]).toEqual([400, "LocalError", "invalid"])
      expect(answer.data.message).toContain(message)
    }
    expect(Config.local()).toMatchObject({ endpoints: [], allow: [], web_domains: { allow: [] } })
  })

  test("a change held from a hand edit applies only as the owner saw it", async () => {
    await turnOn()
    // An edit to the user's config by hand, or by a program the agent ran, is held: it would turn Vector Local off.
    const file = GLOBAL_FILES.find((item) => existsSync(item))!
    const value = parse(readFileSync(file, "utf8")) as Record<string, any>
    writeFileSync(file, JSON.stringify({ ...value, local: { ...value.local, enabled: false } }, null, 2))
    Config.refreshLocal()
    const status = await json(await send("GET", "/local"))
    expect(status.policy.enabled).toBe(true)
    expect(status.held.changes).toEqual(["turns Vector Local off"])

    const unseen = await json(await patch({ held: ["allows github"], confirm: true }))
    expect(unseen.data).toMatchObject({ code: "changed", changes: ["turns Vector Local off"] })
    expect((await patch({ held: ["turns Vector Local off"] })).status).toBe(409)
    expect((await json(await patch({ held: ["turns Vector Local off"], confirm: true, web: "none" }))).data.code).toBe(
      "invalid",
    )
    expect(Config.local().enabled).toBe(true)

    const applied = await json(await patch({ held: ["turns Vector Local off"], confirm: true }))
    expect(applied.policy.enabled).toBe(false)
    expect(applied.held).toBeUndefined()
    // Nothing is held now, so there is nothing to confirm.
    expect((await json(await patch({ held: ["turns Vector Local off"], confirm: true }))).data.code).toBe("changed")
  })

  test("a Vector the agent or its own terminal started cannot loosen Vector Local, but can tighten it", async () => {
    await turnOn()
    process.env[ChildEnvironment.AGENT_MARKER] = "ses_agent"
    expect((await json(await send("GET", "/local"))).agent).toBe(true)
    const refused = await json(await patch({ enabled: false, confirm: true }))
    expect(refused.data).toMatchObject({ code: "agent", changes: ["turns Vector Local off"] })
    expect((await patch({ endpoints: { add: ["http://127.0.0.1:8000"] }, confirm: true })).status).toBe(400)
    expect((await send("POST", "/local/grant", { source: "embedding-model" })).status).toBe(400)
    expect(Config.local()).toMatchObject({ enabled: true, endpoints: [] })
    expect((await patch({ web: "none" })).status).toBe(200)
    expect(Config.local().web).toBe("none")
  })

  test("the network log: what Vector sent, its counters, an export as JSON lines or CSV, the desktop's events, and Erase", async () => {
    await turnOn({ endpoints: { add: ["http://127.0.0.1:11434"] } })
    Egress.decide({ source: "model-catalog", url: "https://vectordev.ai/api/models" })
    Egress.decide({ source: "local-inference", url: "http://127.0.0.1:11434/v1/chat/completions", method: "POST" })
    const desktop: LocalMode.Event = {
      id: "evt_desktop",
      time: Date.now(),
      source: "updates",
      purpose: "updates",
      class: "internet",
      origin: "https://releases.example.com",
      method: "GET",
      decision: "block",
      rule: "automatic-update",
      reason: "Vector Local turns off automatic update checks.",
      carried: { personal: 0, documents: 0, repository: 0 },
    }
    expect(await json(await send("POST", "/local/egress/report", { events: [desktop] }))).toBe(1)

    const events = (await json(await send("GET", "/local/egress"))) as LocalMode.Event[]
    expect(events.map((event) => [event.source, event.decision])).toEqual([
      ["model-catalog", "block"],
      ["local-inference", "allow"],
      ["updates", "block"],
    ])
    // Origins only: never a path or a query.
    expect(events.map((event) => event.origin)).toEqual([
      "https://vectordev.ai",
      "http://127.0.0.1:11434",
      "https://releases.example.com",
    ])
    const blocked = (await json(await send("GET", "/local/egress?blocked=true"))) as LocalMode.Event[]
    expect(blocked.map((event) => event.source)).toEqual(["model-catalog", "updates"])

    const summary = await json(await send("GET", "/local/egress/summary"))
    expect(summary).toMatchObject({
      model_calls: { "http://127.0.0.1:11434": 1 },
      blocked: { "model-catalog": 1, updates: 1 },
    })

    const lines = await send("GET", "/local/egress/export")
    expect(lines.headers.get("content-type")).toContain("application/x-ndjson")
    const exported = (await lines.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LocalMode.Event)
    expect(exported.map((event) => event.source)).toContain("local-inference")
    const csv = await send("GET", "/local/egress/export?format=csv&blocked=true")
    expect(csv.headers.get("content-type")).toContain("text/csv")
    const rows = (await csv.text()).split("\n")
    expect(rows[0]).toBe(
      "time,source,purpose,class,origin,method,bytes_out,decision,rule,reason,session_id,root_session_id,tool,personal,documents,repository",
    )
    expect(rows.slice(1).map((row) => row.split(",")[1])).toEqual(["model-catalog", "updates"])

    expect(await json(await send("DELETE", "/local/egress"))).toBe(true)
    expect(await json(await send("GET", "/local/egress"))).toEqual([])
  })

  test("Find servers reads this computer; reading a typed address identifies the server and its models", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      const found = (await json(await send("POST", "/local/detect", { ports: [fake.port] }))) as { origin: string }[]
      expect(found.some((server) => server.origin === fake.origin)).toBe(true)
      const read = await json(await send("POST", "/local/probe", { url: `${fake.origin}/v1/chat/completions` }))
      expect(read.server).toMatchObject({
        kind: "ollama",
        origin: fake.origin,
        baseURL: `${fake.origin}/v1`,
        version: "0.12.6",
        class: "this-computer",
        pin: { kind: "ollama", version: "0.12.6" },
      })
      expect(read.server.models.map((model: { id: string }) => model.id)).toContain("qwen3-coder:30b")
      const nothing = await json(await send("POST", "/local/probe", { url: "http://127.0.0.1:9/v1" }))
      expect(nothing).toEqual({ server: null, message: "No model server Vector knows answered at http://127.0.0.1:9." })
    } finally {
      await fake.close()
    }
  })

  test("Add server lists the server with its identity and adds its models; with Vector Local on it asks first", async () => {
    const ollama = await LocalServers.serve("ollama")
    const studio = await LocalServers.serve("lmstudio")
    try {
      const added = await json(await send("POST", "/local/servers", { url: `${ollama.origin}/v1` }))
      expect(added).toMatchObject({ provider: "ollama", server: { kind: "ollama", origin: ollama.origin } })
      // Its cloud model runs on ollama.com, and its embedding model writes no text, so neither is added.
      expect(added.models).toEqual(["gemma3:12b", "llama3.3:70b", "qwen3-coder:30b"])
      expect(added.status.policy.endpoints).toEqual([{ origin: ollama.origin, from: "user" }])
      expect(written()?.pins).toEqual({ [ollama.origin]: added.server.pin })
      const provider = GLOBAL_FILES.filter((file) => existsSync(file))
        .map((file) => (parse(readFileSync(file, "utf8")) as { provider?: Record<string, any> }).provider?.ollama)
        .find(Boolean)
      expect(provider).toMatchObject({
        npm: "@ai-sdk/openai-compatible",
        name: `Ollama (${new URL(ollama.origin).host})`,
        options: { baseURL: `${ollama.origin}/v1` },
        models: { "llama3.3:70b": { name: "llama3.3:70b", tool_call: true } },
      })

      await turnOn()
      const asked = await send("POST", "/local/servers", { url: studio.origin })
      expect(asked.status).toBe(409)
      expect((await json(asked)).data.changes).toEqual([`adds the model server ${studio.origin}`])
      expect(Config.local().endpoints.map((item) => item.origin)).toEqual([ollama.origin])
      const confirmed = await json(await send("POST", "/local/servers", { url: studio.origin, confirm: true }))
      // lmstudio is the catalog's own provider, so a server added by hand gets the app's name for it.
      expect(confirmed.provider).toBe("lm-studio")
      expect(Config.local().endpoints.map((item) => item.origin)).toEqual([ollama.origin, studio.origin])

      const taken = await json(
        await send("POST", "/local/servers", { url: studio.origin, provider: "ollama", confirm: true }),
      )
      expect(taken.data).toMatchObject({ code: "invalid", message: expect.stringContaining("unused provider name") })
      const nothing = await json(await send("POST", "/local/servers", { url: "http://127.0.0.1:9" }))
      expect(nothing.data.code).toBe("not-found")
    } finally {
      await ollama.close()
      await studio.close()
    }
  })

  test("with Web access None, reading a typed internet server is refused before anything connects", async () => {
    await turnOn({ web: "none" })
    const read = await json(await send("POST", "/local/probe", { url: "https://models.example.com/v1" }))
    expect(read.server).toBeNull()
    expect(read.message).toContain("Web access is set to None")
  })

  test("Check reads every layer, and a listed server that stops answering fails its row", async () => {
    const fake = await LocalServers.serve("ollama")
    try {
      const pin = (await json(await send("POST", "/local/probe", { url: fake.origin }))).server.pin
      await turnOn({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: pin } })
      const report = await json(await send("POST", "/local/check", {}))
      expect(report.enabled).toBe(true)
      const layers = report.rows.map((row: { layer: string }) => row.layer)
      expect(layers).toEqual(
        expect.arrayContaining(["switch", "guard", "unlabelled", "services", "web", "server", "log"]),
      )
      const server = report.rows.find((row: { layer: string }) => row.layer === "server")
      // The fake Ollama lists a cloud model, which runs on ollama.com, so its row says the server passes models on.
      expect(server).toMatchObject({
        status: "warn",
        title: `Ollama 0.12.6 at ${new URL(fake.origin).host}`,
        detail: expect.stringContaining("It answers as it did when it was added. This server may pass your prompts"),
        origin: fake.origin,
      })
      expect(report.rows.find((row: { layer: string }) => row.layer === "unlabelled").status).toBe("pass")
    } finally {
      await fake.close()
    }
    const after = await json(await send("POST", "/local/check", {}))
    expect(after.result).toBe("fail")
    expect(after.rows.find((row: { layer: string }) => row.layer === "server")).toMatchObject({
      status: "fail",
      title: expect.stringContaining("Nothing answered"),
    })
  })

  test("Check with Vector Local off says so and enforces nothing", async () => {
    const report = await json(await send("POST", "/local/check"))
    expect(report).toMatchObject({
      enabled: false,
      result: "off",
      rows: [{ layer: "switch", title: "Vector Local is off" }],
    })
  })

  test("Check models runs a listed model with the agent's tools and records the result in the user's config", async () => {
    const fake = await LocalServers.serve("ollama", { routes: { "POST /v1/chat/completions": LocalServers.chat() } })
    try {
      const pin = (await json(await send("POST", "/local/probe", { url: fake.origin }))).server.pin
      // The provider goes in the user's config as the app's custom provider dialog writes it.
      const provider = await fetch(new URL("/global/config", listener.url), {
        method: "PATCH",
        headers: { ...owner, "content-type": "application/json" },
        body: JSON.stringify({
          provider: {
            "ollama-test": {
              npm: "@ai-sdk/openai-compatible",
              name: "Ollama (test)",
              options: { baseURL: `${fake.origin}/v1` },
              models: {
                "qwen3-coder:30b": { name: "qwen3-coder:30b", tool_call: true },
                "llama3.3:70b": { name: "llama3.3:70b", tool_call: true },
              },
            },
          },
        }),
        keepalive: false,
      })
      expect(provider.status).toBe(200)
      await turnOn({ endpoints: { add: [fake.origin] }, pins: { [fake.origin]: pin } })
      const check = async (model: string) =>
        (await json(await send("POST", "/local/check", { model: `ollama-test/${model}`, confirmed: true }))).model
      // The server has this model loaded with an 8,192-token context, which the agent's prompt and tools do not fit in,
      // so the check says so before it sends anything.
      expect(await check("qwen3-coder:30b")).toMatchObject({
        model: "qwen3-coder:30b",
        result: "context-too-small",
        requests: 0,
        message: expect.stringContaining("Vector's agent needs about"),
      })
      expect(fake.hits().some((hit) => hit.path === "/v1/chat/completions")).toBe(false)
      // This one fits: it calls a simple tool, the tool with the most nested parameters, and answers a tool result.
      const works = await check("llama3.3:70b")
      expect(works).toMatchObject({ model: "llama3.3:70b", result: "works", server_version: "0.12.6" })
      const sent = fake
        .hits()
        .filter((hit) => hit.path === "/v1/chat/completions")
        .map((hit) => JSON.parse(hit.body) as { model: string; tools: { function: { name: string } }[] })
      expect(sent.length).toBe(works.requests)
      // Each request carries the build agent's real tools.
      expect(sent[0]!.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["read", "edit", "bash"]))
      expect(written()?.checked).toMatchObject({
        "ollama-test/qwen3-coder:30b": { result: "context-too-small" },
        "ollama-test/llama3.3:70b": { result: "works" },
      })

      const unknown = await send("POST", "/local/check", { model: "nowhere/model" })
      expect([unknown.status, (await json(unknown)).data.code]).toEqual([400, "invalid"])
    } finally {
      await fake.close()
    }
  })

  test("a grant answers one ask, and is refused for a service Vector Local never asks about", async () => {
    await turnOn()
    const download = LocalSources.get("embedding-model")!
    const url = `https://${download.hosts[0] ?? "huggingface.co"}/model.onnx`
    expect(Egress.decide({ source: download.id, url }).decision).toBe("ask")
    expect(await json(await send("POST", "/local/grant", { source: download.id }))).toBe(true)
    expect(Egress.decide({ source: download.id, url }).decision).toBe("allow")
    expect(Egress.decide({ source: download.id, url }).decision).toBe("ask")

    const never = await json(await send("POST", "/local/grant", { source: "github" }))
    expect(never.data.code).toBe("invalid")
    const missing = await json(await send("POST", "/local/grant", { source: "no-such-source" }))
    expect(missing.data.code).toBe("not-found")
  })

  test("model suggestions name dated examples with their label", async () => {
    const suggested = await json(await send("GET", "/local/recommend"))
    expect(suggested.label).toContain("Check each model's licence")
    expect(suggested.hardware.summary).toStartWith("This computer has")
    expect(Object.keys(suggested.roles).sort()).toEqual(["agent", "judge", "research", "review", "small", "subagent"])
  })

  test("the owner's event stream hears when Vector Local changes", async () => {
    const controller = new AbortController()
    const response = await fetch(new URL("/global/event", listener.url), {
      headers: owner,
      signal: controller.signal,
      keepalive: false,
    })
    const reader = response.body!.getReader()
    const state = { text: "", acted: false }
    const deadline = Date.now() + 5_000
    try {
      while (Date.now() < deadline && !state.text.includes('"local.updated"')) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => undefined)])
        if (!chunk || chunk.done) break
        state.text += new TextDecoder().decode(chunk.value)
        if (!state.acted && state.text.includes("server.connected")) {
          state.acted = true
          expect((await patch({ enabled: true })).status).toBe(200)
        }
      }
    } finally {
      controller.abort()
    }
    const event = state.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { payload: { type: string; properties: unknown } })
      .find((item) => item.payload.type === "local.updated")
    expect(event?.payload.properties).toEqual({ enabled: true, web: "ask", lock: false, held: false })
  })

  test("nothing any route did left this computer", () => {
    expect(guard.outside()).toEqual([])
  })
})
