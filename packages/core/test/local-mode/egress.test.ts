import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import workerThreads from "node:worker_threads"
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

describe("Egress before the policy is resolved", () => {
  test("reaches only this computer while pending, for every purpose", async () => {
    Egress.pending()
    expect(Egress.policy().pending).toBe(true)
    expect(await (await Egress.fetch("local-inference", `${MODEL}/v1`)).text()).toBe("completion")
    expect(await (await fetch(`${MODEL}/v1`)).text()).toBe("completion")
    for (const [source, url] of [
      ["local-inference", "http://10.0.0.5:8000/v1"],
      ["webfetch", "https://example.org/"],
      ["model-catalog", "https://vectordev.ai/api/models"],
    ] as const)
      expect({ source, rule: Egress.decide({ source, url }).rule }).toEqual({ source, rule: "pending" })
    await expect(fetch(`http://${OUTSIDE}/`)).rejects.toThrow("Vector Local is starting")
    // Once config resolves the policy, it is the one in effect.
    Egress.configure(on())
    expect(Egress.decide({ source: "local-inference", url: `${MODEL}/v1` }).rule).toBe("listed")
  })

  test("starts pending when the environment turns Vector Local on, as a nested vector inherits it", async () => {
    await using dir = await tmpdir()
    const script = path.join(dir.path, "pending.ts")
    await Bun.write(
      script,
      `import { Egress } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/egress.ts"))}
Egress.backstop()
const pending = Egress.policy().pending === true
const before = Egress.decide({ source: "local-inference", url: "http://10.0.0.5:8000/v1" }).rule
Egress.resolve({ env: process.env, global: { endpoints: ["http://10.0.0.5:8000"] } })
const after = Egress.decide({ source: "local-inference", url: "http://10.0.0.5:8000/v1" }).rule
console.log(JSON.stringify({ pending, before, after, enabled: Egress.policy().enabled }))
`,
    )
    const run = (env: Record<string, string>) =>
      Bun.spawn([process.execPath, script], { env: { PATH: process.env.PATH ?? "", ...env }, stdout: "pipe" })
    const on = run({ VECTOR_LOCAL: "1" })
    const off = run({})
    const [started, plain] = await Promise.all([new Response(on.stdout).text(), new Response(off.stdout).text()])
    expect(JSON.parse(started)).toEqual({ pending: true, before: "pending", after: "listed", enabled: true })
    expect(JSON.parse(plain)).toMatchObject({ pending: false, before: "local-off" })
  })
})

describe("Egress and the backstop in Workers", () => {
  // A Worker that reports whether its own guard is in place with Vector Local on, and only then tries the outside, so
  // a failure never connects anywhere.
  const script = async () => {
    const file = path.join(os.tmpdir(), `vector-egress-worker-${process.pid}.ts`)
    await Bun.write(
      file,
      `import { Egress } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/egress.ts"))}
import { EgressGuard } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/guard.ts"))}
const { parentPort } = await import("node:worker_threads")
const send = (message) => (parentPort ? parentPort.postMessage(message) : postMessage(message))
const check = async () => {
  const guarded = EgressGuard.installed() && Egress.policy().enabled
  const fetched = guarded
    ? await fetch("http://${OUTSIDE}/w").then(() => "reached", (error) => error?.name ?? String(error))
    : "skipped"
  send({ guarded, fetched, endpoints: Egress.policy().endpoints.map((item) => item.origin) })
}
if (parentPort) parentPort.on("message", check)
else self.onmessage = check
send("ready")
`,
    )
    return file
  }
  // Asks until the Worker has the policy: the channel and the Worker's own port are not ordered between them.
  const ask = async (post: () => void, next: () => Promise<unknown>, left = 50): Promise<unknown> => {
    post()
    const answer = (await next()) as { guarded: boolean }
    if (answer.guarded || left <= 1) return answer
    await Bun.sleep(20)
    return ask(post, next, left - 1)
  }
  const messages = (subscribe: (listener: (message: unknown) => void) => void) => {
    const queue: unknown[] = []
    const waiting: ((message: unknown) => void)[] = []
    subscribe((message) => (waiting.length > 0 ? waiting.shift()!(message) : queue.push(message)))
    return () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve)))
  }
  const blockedOutside = async (left = 50): Promise<LocalMode.Event[]> => {
    const found = Egress.events({ blocked: true }).filter((event) => event.origin === `http://${OUTSIDE}`)
    if (found.length > 0 || left <= 1) return found
    await Bun.sleep(20)
    return blockedOutside(left - 1)
  }

  test("starts a Worker with the policy in effect and logs what it blocks where the app reads it", async () => {
    Egress.configure(on())
    const file = await script()
    const web = new Worker(file)
    const next = messages((listener) => (web.onmessage = (event) => listener(event.data)))
    expect(await next()).toBe("ready")
    expect(await ask(() => web.postMessage("check"), next)).toEqual({
      guarded: true,
      fetched: "EgressBlocked",
      endpoints: [MODEL],
    })
    web.terminate()
    const blocked = await blockedOutside()
    expect(blocked.map((event) => [event.source, event.rule])).toEqual([["unlabelled", "unlabelled"]])
    expect(blocked[0]!.frame).toContain("vector-egress-worker")
  })

  test("keeps a Worker started with Vector Local off on the policy set after it started", async () => {
    Egress.configure(LocalPolicy.OFF)
    const file = await script()
    // The node:worker_threads module object's class, as a module that reads it at call time gets it.
    const thread = new workerThreads.Worker(file)
    const next = messages((listener) => thread.on("message", listener))
    expect(await next()).toBe("ready")
    thread.postMessage("check")
    expect(await next()).toEqual({ guarded: false, fetched: "skipped", endpoints: [] })
    Egress.configure(on())
    expect(await ask(() => thread.postMessage("check"), next)).toEqual({
      guarded: true,
      fetched: "EgressBlocked",
      endpoints: [MODEL],
    })
    await thread.terminate()
    expect((await blockedOutside()).map((event) => event.rule)).toEqual(["unlabelled"])
  })
})

describe("the test-only environment under Vector Local", () => {
  test("cannot loosen a process the environment turns Vector Local on for", async () => {
    await using dir = await tmpdir()
    const script = path.join(dir.path, "loosen.ts")
    await Bun.write(
      script,
      `import ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/backstop.ts"))}
import net from "node:net"
import { Egress } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/egress.ts"))}
const seen = []
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  seen.push(request.url)
  return new Response("proxied")
} })
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("completion") })
// What the agent would set for a nested vector: the test guard's pinned names and its proxy.
process.env.HTTP_PROXY = \`http://127.0.0.1:\${proxy.port}\`
process.env.VECTOR_TEST_EGRESS_PROXY = process.env.HTTP_PROXY
process.env.NO_PROXY = ""
Egress.resolve({ env: process.env, global: { endpoints: [\`http://127.0.0.1:\${model.port}\`] } })
const socket = await new Promise((resolve) => {
  const made = net.connect(80, "${OUTSIDE}")
  made.on("error", (error) => resolve(error.name))
  made.on("connect", () => resolve("connected"))
  made.setTimeout(2000, () => resolve("timed out"))
})
const prompt = await Egress.fetch("local-inference", \`http://127.0.0.1:\${model.port}/v1/chat/completions\`, {
  method: "POST",
  body: "secret prompt",
}).then((response) => response.text())
console.log(JSON.stringify({ socket, prompt, seen, blocked: Egress.events({ blocked: true }).map((event) => event.origin) }))
proxy.stop(true)
model.stop(true)
`,
    )
    const child = Bun.spawn([process.execPath, script], {
      env: {
        PATH: process.env.PATH ?? "",
        VECTOR_LOCAL: "1",
        VECTOR_TEST_EGRESS: "strict",
        VECTOR_TEST_EGRESS_NAMES: OUTSIDE,
      },
      stdout: "pipe",
    })
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      socket: "EgressBlocked",
      prompt: "completion",
      seen: [],
      blocked: [`${OUTSIDE}:80`],
    })
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

  test("a folder Vector cannot use keeps the policy, logs in memory, says so and is tried again", async () => {
    await using dir = await tmpdir()
    const directory = path.join(dir.path, "local")
    fs.writeFileSync(directory, "not a folder")
    const policy = Egress.configure(on(), { log: { directory } })
    expect(policy).toMatchObject({ enabled: true, endpoints: [{ origin: MODEL }] })
    expect(policy.warnings).toHaveLength(1)
    expect(policy.warnings[0]).toStartWith(`Vector could not write its network log in ${directory}`)
    expect(Egress.policy()).toBe(policy)
    expect(Egress.decide({ source: "model-catalog", url: "https://models.dev/api.json" }).decision).toBe("block")
    // Export falls back to the events in memory.
    expect((await Egress.exported()).map((event) => event.source)).toEqual(["model-catalog"])

    fs.rmSync(directory)
    expect(Egress.configure(on()).warnings).toEqual([])
    Egress.decide({ source: "local-inference", url: `${MODEL}/v1` })
    expect((await Egress.exported()).map((event) => event.source)).toEqual(["local-inference"])
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

  test("sends a model call to a listed server on this computer direct, never through the proxy environment", async () => {
    Egress.configure(on())
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seenByProxy.push(`${request.url} ${await request.text()}`)
        return new Response("proxied")
      },
    })
    const saved = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]] as const)
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    // Emptied, never deleted: Bun's fetch never sees a variable that was deleted set again.
    process.env.NO_PROXY = ""
    process.env.no_proxy = ""
    try {
      const labelled = await Egress.fetch("local-inference", `${MODEL}/v1/chat/completions`, {
        method: "POST",
        body: "secret prompt",
      })
      expect(await labelled.text()).toBe("completion")
      expect(await (await fetch(`${MODEL}/v1`)).text()).toBe("completion")
      expect(seenByProxy).toEqual([])
      // What it sent is counted; what came back is not known when it is decided.
      const call = Egress.events().find((event) => event.source === "local-inference")
      expect(call).toMatchObject({ decision: "allow", method: "POST", bytes_out: 13 })
      expect(call?.bytes_in).toBeUndefined()
    } finally {
      saved.forEach(([key, value]) => {
        process.env[key] = value ?? ""
      })
      proxy.stop(true)
    }
  })

  test("sends a model call to a listed IPv6 server direct when NO_PROXY names it only as Bun does not read it", async () => {
    const ipv6 = Object.values(os.networkInterfaces())
      .flat()
      .some((item) => item?.address === "::1")
    if (!ipv6) return
    const six = Bun.serve({
      hostname: "::1",
      port: 0,
      fetch: async (request) => new Response(`six ${await request.text()}`),
    })
    Egress.configure(on({ endpoints: [`http://[::1]:${six.port}`] }))
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seenByProxy.push(`${request.url} ${await request.text()}`)
        return new Response("from-proxy")
      },
    })
    const saved = ["HTTP_PROXY", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]] as const)
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    // What the desktop writes for its engine.
    process.env.NO_PROXY = "localhost,127.0.0.1,::1"
    process.env.no_proxy = "localhost,127.0.0.1,::1"
    try {
      const reply = await Egress.fetch("local-inference", `http://[::1]:${six.port}/v1/chat/completions`, {
        method: "POST",
        body: "secret prompt",
      })
      expect(await reply.text()).toBe("six secret prompt")
      expect(seenByProxy).toEqual([])
    } finally {
      saved.forEach(([key, value]) => {
        process.env[key] = value ?? ""
      })
      proxy.stop(true)
      six.stop(true)
    }
  })

  test("passes straight through with Vector Local off", async () => {
    const response = await Egress.fetch("webfetch", web.url("page", "/"), viaWeb)
    expect(await response.text()).toBe("page")
    expect(Egress.events()).toEqual([])
  })
})
