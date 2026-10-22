import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
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
  // The backstop reads this machine's own config and company policy; these tests start from Vector Local off.
  Egress.configure(LocalPolicy.OFF)
})
// Runs a script of its own with the egress service, in a fresh process with no config of the machine's own.
const spawned = async (dir: string, body: string, env: Record<string, string> = {}) => {
  const script = path.join(dir, `script-${Math.random().toString(36).slice(2)}.ts`)
  const imports = [
    `import { Egress } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/egress.ts"))}`,
    `import { LocalPolicy } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/policy.ts"))}`,
  ]
  await Bun.write(script, [...imports, body].join("\n"))
  const child = Bun.spawn([process.execPath, script], {
    env: {
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_STATE_HOME: path.join(dir, "state"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const line = stdout.trim().split("\n").at(-1) ?? ""
  if (!line.startsWith("{")) throw new Error(`The script printed no result:\n${stdout}\n${stderr}`)
  return JSON.parse(line) as Record<string, unknown>
}
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
    // No config of the machine's own: the backstop reads the user's config folders too.
    const run = (env: Record<string, string>) =>
      Bun.spawn([process.execPath, script], {
        env: {
          PATH: process.env.PATH ?? "",
          XDG_CONFIG_HOME: path.join(dir.path, "config"),
          XDG_STATE_HOME: path.join(dir.path, "state"),
          ...env,
        },
        stdout: "pipe",
      })
    const on = run({ VECTOR_LOCAL: "1" })
    const off = run({})
    const [started, plain] = await Promise.all([new Response(on.stdout).text(), new Response(off.stdout).text()])
    expect(JSON.parse(started)).toEqual({ pending: true, before: "pending", after: "listed", enabled: true })
    expect(JSON.parse(plain)).toMatchObject({ pending: false, before: "local-off" })
  })

  test("starts pending when the user's config turns Vector Local on, with nothing in the environment", async () => {
    await using dir = await tmpdir()
    const body = `import net from "node:net"
Egress.backstop()
const pending = Egress.policy().pending === true
// Only tried while the guard holds connections: a guard that let it through would try a real address.
const socket = pending
  ? await new Promise((resolve) => {
      const made = net.connect(443, "${OUTSIDE}")
      made.on("error", (error) => resolve({ name: error.name, rule: error.rule }))
      made.on("connect", () => resolve("connected"))
    })
  : "not tried"
console.log(JSON.stringify({ pending, socket }))`
    fs.mkdirSync(path.join(dir.path, "config", "vector"), { recursive: true })
    fs.writeFileSync(
      path.join(dir.path, "config", "vector", "vector.jsonc"),
      `{\n  // Vector Local\n  "local": { "enabled": true },\n}`,
    )
    expect(await spawned(dir.path, body)).toEqual({
      pending: true,
      socket: { name: "EgressBlocked", rule: "pending" },
    })
    fs.writeFileSync(path.join(dir.path, "config", "vector", "vector.jsonc"), `{ "local": { "enabled": false } }`)
    expect(await spawned(dir.path, body)).toEqual({ pending: false, socket: "not tried" })
  })

  test("cannot be loosened by the test variables once Vector Local is on", async () => {
    await using dir = await tmpdir()
    const body = `import net from "node:net"
const seen = []
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => { seen.push(await request.text()); return new Response("proxied") } })
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("direct") })
process.env.HTTP_PROXY = \`http://127.0.0.1:\${proxy.port}\`
process.env.VECTOR_TEST_EGRESS_PROXY = process.env.HTTP_PROXY
const handle = Egress.backstop()
const answer = (_host, options, callback) => options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4)
// A name the test variables would pin to this computer, answered by a resolver that says so.
const named = await new Promise((resolve) => {
  try {
    const socket = net.connect({ host: "api.openai.com", port: model.port, lookup: answer })
    socket.on("connect", () => { socket.destroy(); resolve("connected") })
    socket.on("error", (error) => resolve(error.name))
  } catch (error) {
    resolve(error.name)
  }
})
Egress.configure(LocalPolicy.resolve({ env: process.env, global: { endpoints: [\`http://127.0.0.1:\${model.port}\`] } }))
const prompt = await Egress.fetch("local-inference", \`http://127.0.0.1:\${model.port}/v1/chat/completions\`, { method: "POST", body: "secret prompt" }).then((response) => response.text(), (error) => error.name)
console.log(JSON.stringify({ named, prompt, seen }))
handle?.uninstall()
proxy.stop(true)
model.stop(true)`
    expect(
      await spawned(dir.path, body, {
        VECTOR_LOCAL: "1",
        VECTOR_TEST_EGRESS: "strict",
        VECTOR_TEST_EGRESS_NAMES: "openai.com",
      }),
    ).toEqual({ named: "EgressBlocked", prompt: "direct", seen: [] })
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

  test("sends a listed model's prompt direct when NO_PROXY covers it only in a form Bun does not honour", async () => {
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seenByProxy.push(`${request.url} ${await request.text()}`)
        return new Response("proxied")
      },
    })
    const six = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("completion on ::1") })
    const saved = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"].map((key) => [key, process.env[key]] as const)
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    const send = (url: string) =>
      Egress.fetch("local-inference", url, { method: "POST", body: "secret prompt" }).then((response) =>
        response.text(),
      )
    try {
      // The desktop writes a bare ::1, which a CLI started from it inherits.
      process.env.NO_PROXY = "localhost,127.0.0.1,::1"
      process.env.no_proxy = "localhost,127.0.0.1,::1"
      Egress.configure(on({ endpoints: [`http://[::1]:${six.port}`] }))
      expect(await send(`http://[::1]:${six.port}/v1/chat/completions`)).toBe("completion on ::1")
      expect(await (await fetch(`http://[::1]:${six.port}/v1`)).text()).toBe("completion on ::1")
      // A company's wildcard.
      process.env.NO_PROXY = "*.localhost"
      process.env.no_proxy = "*.localhost"
      Egress.configure(on({ endpoints: [`http://localhost:${model.port}`] }))
      expect(await send(`http://localhost:${model.port}/v1/chat/completions`)).toBe("completion")
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

describe("Workers under Vector Local", () => {
  // A worker that fetches an address off this computer once its guard follows a policy with Vector Local on.
  const body = `import { EgressGuard } from ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/guard.ts"))}
const { parentPort } = await import("node:worker_threads")
const post = (value) => (parentPort ? parentPort.postMessage(value) : postMessage(value))
const followed = () => EgressGuard.followed?.()?.enabled === true
const on = async () => {
  for (let tries = 0; tries < 200 && !followed(); tries++) await Bun.sleep(10)
  return followed()
}
const run = async () => {
  if (!(await on())) return "Vector Local never reached this worker"
  return fetch("http://${OUTSIDE}/worker").then(() => "reached", (error) => error?.name ?? String(error))
}
const handle = (message) => message === "go" && run().then(post)
if (parentPort) parentPort.on("message", handle)
else self.onmessage = (event) => handle(event.data)
post("ready")
`
  type Started = { send: (message: string) => void; next: () => Promise<unknown>; stop: () => unknown }
  const start = (file: string, kind: "global" | "thread"): Started => {
    const queue: unknown[] = []
    const waiting: ((value: unknown) => void)[] = []
    const deliver = (value: unknown) => (waiting.length ? waiting.shift()!(value) : queue.push(value))
    const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiting.push(resolve)))
    if (kind === "global") {
      const worker = new Worker(file)
      worker.onmessage = (event) => deliver(event.data)
      return { send: (message) => worker.postMessage(message), next, stop: () => worker.terminate() }
    }
    const worker = new workerThreads.Worker(file)
    worker.on("message", deliver)
    return { send: (message) => worker.postMessage(message), next, stop: () => worker.terminate() }
  }
  const logged = async () => {
    for (let tries = 0; tries < 200; tries++) {
      const found = Egress.events({ blocked: true }).find((event) => event.origin === `http://${OUTSIDE}`)
      if (found) return found
      await Bun.sleep(10)
    }
    return undefined
  }

  test("refuses a worker's connection off this computer and logs it here, from either Worker class", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "worker.ts")
    await Bun.write(file, body)
    Egress.configure(on())
    for (const kind of ["global", "thread"] as const) {
      const worker = start(file, kind)
      expect(await worker.next()).toBe("ready")
      worker.send("go")
      expect({ kind, outcome: await worker.next() }).toEqual({ kind, outcome: "EgressBlocked" })
      await worker.stop()
      const event = await logged()
      expect(event).toMatchObject({ source: "unlabelled", purpose: "unknown", decision: "block", rule: "unlabelled" })
      expect(event?.frame).toContain("worker.ts")
      await Egress.erase()
    }
  })

  test("lets a worker entry that decides its own policy, or seals itself, take over from the guard it followed", async () => {
    await using dir = await tmpdir()
    const source = (file: string) => JSON.stringify(path.join(import.meta.dir, "../../src/local-mode", file))
    const report = `const { parentPort } = await import("node:worker_threads")
parentPort.postMessage(result)
`
    const engine = path.join(dir.path, "engine.ts")
    await Bun.write(
      engine,
      `import ${source("backstop.ts")}
import { EgressGuard } from ${source("guard.ts")}
import { Egress } from ${source("egress.ts")}
const result = { following: EgressGuard.followed() !== undefined, installed: EgressGuard.installed(), enabled: Egress.policy().enabled }
${report}`,
    )
    const sealed = path.join(dir.path, "sealed.ts")
    await Bun.write(
      sealed,
      `import ${source("backstop-worker.ts")}
import { EgressGuard } from ${source("guard.ts")}
const following = EgressGuard.followed() !== undefined
// Tried only once the worker's own guard is in place.
const connect = following
  ? "not tried"
  : await Bun.connect({ hostname: "${OUTSIDE}", port: 80, socket: { data() {} } }).then(() => "reached", (error) => error.name)
const result = { following, connect }
${report}`,
    )
    const run = (file: string) => {
      const worker = new workerThreads.Worker(file)
      return new Promise<unknown>((resolve) => worker.once("message", resolve)).finally(() => worker.terminate())
    }
    Egress.configure(on())
    expect(await run(engine)).toEqual({ following: false, installed: true, enabled: true })
    // With Vector Local off a worker that makes no connections of its own still refuses every one off this computer.
    Egress.configure(LocalPolicy.OFF)
    expect(await run(sealed)).toEqual({ following: false, connect: "EgressBlocked" })
  })

  test("follows the policy as it changes after the worker started", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "worker.ts")
    await Bun.write(file, body)
    const worker = start(file, "global")
    expect(await worker.next()).toBe("ready")
    // Started with Vector Local off; turned on afterwards.
    Egress.configure(on())
    worker.send("go")
    expect(await worker.next()).toBe("EgressBlocked")
    await worker.stop()
    expect(await logged()).toMatchObject({ decision: "block" })
  })

  test("seals the workers a sealed worker starts, even where the test variables mean nothing", async () => {
    await using dir = await tmpdir()
    const source = (file: string) => JSON.stringify(path.join(import.meta.dir, "../../src/local-mode", file))
    // The model server on your network that the main thread's policy lists, which only a sealed thread refuses.
    const listed = "192.168.255.254"
    const nested = path.join(dir.path, "nested.ts")
    await Bun.write(
      nested,
      `import { EgressGuard } from ${source("guard.ts")}
// Long enough for a guard that followed the main thread to hear its policy.
await Bun.sleep(200)
const connect = await Promise.race([
  Bun.connect({ hostname: "${listed}", port: 9, socket: { data() {} } }).then(() => "connected", (error) => error.name),
  Bun.sleep(1_000).then(() => "not refused"),
])
postMessage({ following: EgressGuard.followed() !== undefined, connect })
`,
    )
    const sealed = path.join(dir.path, "sealed.ts")
    await Bun.write(
      sealed,
      `import ${source("backstop-worker.ts")}
const worker = new Worker(${JSON.stringify(nested)})
worker.onmessage = (event) => postMessage(event.data)
`,
    )
    const body = `Egress.backstop()
Egress.configure(LocalPolicy.resolve({ env: process.env, global: { endpoints: ["http://${listed}:9"] } }))
const worker = new Worker(${JSON.stringify(sealed)})
const result = await new Promise((resolve) => (worker.onmessage = (event) => resolve(event.data)))
console.log(JSON.stringify(result))
process.exit(0)`
    // With Vector Local on the test variables are not honoured, as in a build.
    expect(await spawned(dir.path, body, { VECTOR_LOCAL: "1" })).toEqual({ following: false, connect: "EgressBlocked" })
  })

  test("never lets a worker's local model prompt reach the proxy, though a Bun worker's fetch ignores its own NO_PROXY", async () => {
    // The company's proxy, in this process: the script below points HTTP_PROXY at it, with NO_PROXY empty.
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        seenByProxy.push(`${request.method} ${request.url} ${await request.text()}`)
        return new Response("proxied")
      },
    })
    await using dir = await tmpdir()
    const source = (file: string) => JSON.stringify(path.join(import.meta.dir, "../../src/local-mode", file))
    const call = `const call = (url, labelled) =>
  (labelled
    ? Egress.fetch("local-inference", url + "/v1/chat/completions", { method: "POST", body: "secret prompt" })
    : fetch(url + "/v1/chat/completions", { method: "POST", body: "secret prompt" })
  ).then((response) => response.text(), (error) => error.rule ?? error.name)`
    // The terminal UI's engine thread: a worker whose entry decides its own policy, and lists one more server itself.
    const engine = path.join(dir.path, "engine.ts")
    await Bun.write(
      engine,
      `import ${source("backstop.ts")}
import { Egress } from ${source("egress.ts")}
import { LocalPolicy } from ${source("policy.ts")}
${call}
self.onmessage = async (event) => {
  const { listed, later } = event.data
  Egress.configure(LocalPolicy.resolve({ global: { enabled: true, endpoints: [...listed, later] } }))
  const results = {}
  for (const url of [...listed, later]) results[url] = [await call(url, true), await call(url, false)]
  const events = Egress.events().filter((item) => item.origin === later).map((item) => [item.source, item.decision, item.rule])
  postMessage({ results, events })
}
postMessage("ready")
`,
    )
    // A worker that follows the policy of the thread that started it, as OpenTUI's parser worker does.
    const follower = path.join(dir.path, "follower.ts")
    await Bun.write(
      follower,
      `import { EgressGuard } from ${source("guard.ts")}
self.onmessage = async (event) => {
  const { listed, later } = event.data
  for (let tries = 0; tries < 200 && !EgressGuard.followed()?.endpoints.some((item) => item.origin === later); tries++)
    await Bun.sleep(10)
  const results = {}
  for (const url of [...listed, later])
    results[url] = await fetch(url + "/v1/chat/completions", { method: "POST", body: "secret prompt" }).then(
      (response) => response.text(),
      (error) => error.rule ?? error.name,
    )
  postMessage(results)
}
postMessage("ready")
`,
    )
    const body = `Egress.backstop()
const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("completion") })
const six = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("completion on ::1") })
const listed = [\`http://127.0.0.1:\${model.port}\`, \`http://[::1]:\${six.port}\`]
// A server on your network listed only after the workers started: their fetch can no longer be sent around the proxy.
const later = "http://192.168.255.254:9"
const policy = (endpoints) => LocalPolicy.resolve({ global: { enabled: true, endpoints } })
Egress.configure(policy(listed))
const started = (file) =>
  new Promise((resolve) => {
    const worker = new Worker(file)
    worker.onmessage = () => resolve(worker)
  })
const ask = (worker, message) =>
  new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data)
    worker.postMessage(message)
  })
const engine = await started(${JSON.stringify(engine)})
const follower = await started(${JSON.stringify(follower)})
Egress.configure(policy([...listed, later]))
const result = {
  listed,
  engine: await ask(engine, { listed, later }),
  follower: await ask(follower, { listed, later }),
}
for (let tries = 0; tries < 200 && !Egress.events({ blocked: true }).some((item) => item.origin === later); tries++)
  await Bun.sleep(10)
result.logged = Egress.events({ blocked: true }).filter((item) => item.origin === later).map((item) => [item.source, item.rule])
console.log(JSON.stringify(result))
process.exit(0)`
    type Result = {
      listed: [string, string]
      engine: { results: Record<string, unknown>; events: unknown }
      follower: Record<string, unknown>
      logged: unknown
    }
    const run = async (env: Record<string, string>) =>
      (await spawned(dir.path, body, { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, ...env })) as Result
    const later = "http://192.168.255.254:9"
    try {
      // NO_PROXY unset when the process starts: what this thread puts on it before a worker starts reaches the worker.
      const unset = await run({})
      const [four, six] = unset.listed
      expect(seenByProxy).toEqual([])
      expect(unset.engine.results).toEqual({
        [four]: ["completion", "completion"],
        [six]: ["completion on ::1", "completion on ::1"],
        [later]: ["proxy-environment", "proxy-environment"],
      })
      // Each refusal is logged once, as refused: never first as a model call that was sent.
      expect(unset.engine.events).toEqual([
        ["local-inference", "block", "proxy-environment"],
        ["unlabelled", "block", "proxy-environment"],
      ])
      expect(unset.follower).toEqual({ [four]: "completion", [six]: "completion on ::1", [later]: "proxy-environment" })
      // What the following worker refused is in the log of the thread it follows.
      expect(unset.logged).toEqual([["unlabelled", "proxy-environment"]])

      // NO_PROXY set, empty, when the process starts: a worker keeps reading it empty, so every call is refused.
      const empty = await run({ NO_PROXY: "", no_proxy: "" })
      const refused = Object.fromEntries([...empty.listed, later].map((url) => [url, "proxy-environment"]))
      expect(seenByProxy).toEqual([])
      expect(empty.engine.results).toEqual(
        Object.fromEntries(Object.keys(refused).map((url) => [url, ["proxy-environment", "proxy-environment"]])),
      )
      expect(empty.follower).toEqual(refused)
    } finally {
      proxy.stop(true)
    }
  }, 30_000)
})
