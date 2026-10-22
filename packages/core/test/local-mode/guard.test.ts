import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import workerThreads from "node:worker_threads"
import { EgressAttribution } from "../../src/local-mode/attribution"
import { EgressGuard } from "../../src/local-mode/guard"
import { LocalPolicy } from "../../src/local-mode/policy"

// A documentation address (TEST-NET-2): never routed, so a guard that failed to block would hang, not reach anyone.
const OUTSIDE = "198.51.100.7"
// Taken before the guard is installed, as a module that kept its own reference would.
const capturedFetch = globalThis.fetch

const seen: { path: string; method: string; authorization: string | null; body: string }[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    seen.push({
      path: url.pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    })
    if (url.pathname === "/out") return Response.redirect(`http://${OUTSIDE}/collect`, 302)
    if (url.pathname === "/hop") return Response.redirect("/landed", 302)
    if (url.pathname === "/see-other") return new Response(null, { status: 303, headers: { location: "/landed" } })
    if (url.pathname === "/keep") return new Response(null, { status: 307, headers: { location: "/landed" } })
    if (url.pathname === "/elsewhere") return Response.redirect(`http://localhost:${url.port}/landed`, 302)
    return new Response("here")
  },
})
afterAll(() => server.stop(true))
const at = (route = "/") => `http://127.0.0.1:${server.port}${route}`

describe("EgressGuard.local", () => {
  test("counts loopback in every spelling as this computer", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "127.0.0.1",
      "127.1",
      "0x7f.1",
      "2130706433",
      "0177.0.0.1",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
      "[::ffff:7f00:1]",
      "0.0.0.0",
    ])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: true })
  })

  test("counts the network and the internet as outside", () => {
    // A name under localhost may be answered by an upstream resolver, so its name alone does not keep it here.
    for (const host of [
      OUTSIDE,
      "10.0.0.5",
      "192.168.1.2",
      "100.64.0.1",
      "example.com",
      "127.0.0.1.example.com",
      "app.localhost",
      "",
    ])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: false })
  })

  test("judges a whole name, never the part before a %", () => {
    // Only an IPv6 address has a zone; anywhere else the resolver would be asked for the whole name.
    for (const host of ["localhost%.evil.example", "127.0.0.1%evil.example", "localhost%25", "::1%lo0%x"])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: false })
    expect(EgressGuard.local("::1%lo0")).toBe(true)
  })

  test("counts names the caller pins to this computer", () => {
    expect(EgressGuard.local("article.web.test", ["web.test"])).toBe(true)
    expect(EgressGuard.local("web.test.example.com", ["web.test"])).toBe(false)
  })
})

describe("EgressGuard.installStrict", () => {
  const state: { handle?: EgressGuard.Handle } = {}
  const original = {
    fetch: globalThis.fetch,
    connect: net.Socket.prototype.connect,
    connect_: Bun.connect,
    WebSocket: globalThis.WebSocket,
    Worker: globalThis.Worker,
    ThreadWorker: workerThreads.Worker,
    env: Object.fromEntries(
      ["HTTP_PROXY", "https_proxy", "NO_PROXY", "VECTOR_TEST_EGRESS"].map((key) => [key, process.env[key]]),
    ),
  }
  beforeAll(() => {
    state.handle = EgressGuard.installStrict()
  })
  afterAll(() => {
    state.handle?.uninstall()
    state.handle = undefined
  })

  test("blocks fetch to an outside address before it connects", async () => {
    await expect(fetch(`http://${OUTSIDE}/`)).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    await expect(fetch(new Request(`https://${OUTSIDE}/x`))).rejects.toThrow(`connection to ${OUTSIDE}`)
    expect(state.handle!.attempts().filter((attempt) => attempt.kind === "fetch" && !attempt.allowed)).toHaveLength(2)
  })

  test("blocks net.connect, a socket's own connect and tls", () => {
    expect(() => net.connect(443, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
    expect(() => net.connect({ host: OUTSIDE, port: 80 })).toThrow(EgressGuard.EgressBlocked)
    expect(() => new net.Socket().connect(80, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
    expect(() => tls.connect(443, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
  })

  test("blocks node:https and node:http requests", () => {
    expect(() => https.get(`https://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
    expect(() => https.request({ host: OUTSIDE, port: 8443, path: "/" }).end()).toThrow(EgressGuard.EgressBlocked)
    expect(() => http.get(`http://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
    expect(state.handle!.attempts().filter((attempt) => attempt.host === OUTSIDE && attempt.allowed)).toEqual([])
  })

  test("blocks a WebSocket to an outside address", () => {
    expect(() => new WebSocket(`wss://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
  })

  test("lets loopback through every path and lists each attempt", async () => {
    expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("here")
    expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toBe("here")
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${server.port}/`, (response) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () => resolve(Buffer.concat(chunks).toString()))
        })
        .on("error", reject)
    })
    expect(body).toBe("here")
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(server.port!, "127.0.0.1", () => {
        socket.destroy()
        resolve()
      })
      socket.on("error", reject)
    })
    const kinds = state
      .handle!.attempts()
      .filter((attempt) => attempt.allowed)
      .map((attempt) => attempt.kind)
    expect(new Set(kinds)).toEqual(new Set(["fetch", "proxied", "http", "socket"]))
  })

  test("refuses Bun.fetch and a fetch taken before install through its own proxy", async () => {
    for (const [client, url] of [
      [Bun.fetch, `http://${OUTSIDE}/a`],
      [capturedFetch, `http://${OUTSIDE}/b`],
      [Bun.fetch, `https://${OUTSIDE}/c`],
    ] as const) {
      const response = await client(url)
      expect({ url, status: response.status }).toEqual({ url, status: 403 })
    }
    const refused = await (await capturedFetch(`http://${OUTSIDE}/d`)).text()
    expect(refused).toBe(`Vector blocked a connection to ${OUTSIDE}: only this computer is reachable here.`)
    expect(state.handle!.attempts().filter((attempt) => attempt.kind === "proxied" && !attempt.allowed)).toHaveLength(4)
    // This computer still answers through it.
    expect(await (await Bun.fetch(at())).text()).toBe("here")
    expect(await (await capturedFetch(at())).text()).toBe("here")
  })

  test("decides each request on a kept-alive connection to its proxy on its own", async () => {
    seen.length = 0
    const proxy = new URL(process.env[EgressGuard.ENVIRONMENT.proxy]!)
    const raw = (text: string) =>
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = []
        const socket = net.connect(Number(proxy.port), proxy.hostname, () => socket.write(text))
        socket.on("data", (chunk: Buffer) => chunks.push(chunk))
        socket.on("end", () => resolve(Buffer.concat(chunks).toString()))
        socket.on("error", reject)
        setTimeout(() => {
          socket.destroy()
          resolve(Buffer.concat(chunks).toString())
        }, 1_000)
      })
    const here = `127.0.0.1:${server.port}`
    const first = `POST http://${here}/first HTTP/1.1\r\nHost: ${here}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`
    // The body is passed on by its chunks, and the server answers.
    expect(await raw(first)).toContain("here")
    expect(seen.map((item) => [item.path, item.body])).toEqual([["/first", "hello world"]])
    // What follows a body on the same connection is a request of its own, and an outside one is refused.
    const replies = await raw(`${first}GET http://${OUTSIDE}/second HTTP/1.1\r\nHost: ${OUTSIDE}\r\n\r\n`)
    expect(replies).toContain("HTTP/1.1 403 Forbidden")
    expect(replies).toContain(`Vector blocked a connection to ${OUTSIDE}`)
    expect(seen.map((item) => item.path)).not.toContain("/second")
  })

  test("decides every redirect hop before it is made", async () => {
    await expect(fetch(at("/out"))).rejects.toThrow(`connection to ${OUTSIDE}`)
    expect(
      state
        .handle!.attempts()
        .filter((attempt) => attempt.host === OUTSIDE && attempt.kind === "fetch")
        .at(-1),
    ).toMatchObject({ allowed: false })
    const followed = await fetch(at("/hop"))
    expect({ status: followed.status, url: followed.url, redirected: followed.redirected }).toEqual({
      status: 200,
      url: at("/landed"),
      redirected: true,
    })
    expect(await followed.text()).toBe("here")
    // A caller that follows redirects itself still gets the redirect.
    const manual = await fetch(at("/out"), { redirect: "manual" })
    expect({ status: manual.status, location: manual.headers.get("location") }).toEqual({
      status: 302,
      location: `http://${OUTSIDE}/collect`,
    })
  })

  test("follows redirects the way fetch does: method, body and credentials", async () => {
    seen.length = 0
    await fetch(at("/see-other"), { method: "POST", body: "form" })
    await fetch(at("/keep"), { method: "PUT", body: "kept" })
    await fetch(at("/hop"), { headers: { authorization: "Bearer same-site" } })
    await fetch(at("/elsewhere"), { headers: { authorization: "Bearer other-site" } })
    expect(seen.map((item) => [item.path, item.method, item.body, item.authorization])).toEqual([
      ["/see-other", "POST", "form", null],
      ["/landed", "GET", "", null],
      ["/keep", "PUT", "kept", null],
      ["/landed", "PUT", "kept", null],
      ["/hop", "GET", "", "Bearer same-site"],
      ["/landed", "GET", "", "Bearer same-site"],
      ["/elsewhere", "GET", "", "Bearer other-site"],
      ["/landed", "GET", "", null],
    ])
    const stream = new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("streamed"))
        controller.close()
      },
    })
    await expect(fetch(at("/keep"), { method: "PUT", body: stream })).rejects.toThrow("streamed request body")
  })

  test("treats any proxy but its own as a way off this computer", async () => {
    await expect(fetch(at(), { proxy: `http://${OUTSIDE}:3128` } as RequestInit)).rejects.toThrow(
      `connection to ${OUTSIDE}`,
    )
    // A proxy on this computer still forwards to wherever it is asked.
    await expect(fetch(at(), { proxy: "http://127.0.0.1:9" } as RequestInit)).rejects.toBeInstanceOf(
      EgressGuard.EgressBlocked,
    )
    // Whichever spelling a client prefers, a proxy off this computer in any of them is refused.
    for (const key of ["HTTP_PROXY", "http_proxy", "ALL_PROXY"]) {
      const before = process.env[key]
      process.env[key] = `http://${OUTSIDE}:8080`
      try {
        await expect(fetch(at())).rejects.toThrow(`connection to ${OUTSIDE}`)
      } finally {
        process.env[key] = before ?? ""
      }
    }
    expect(await (await fetch(at())).text()).toBe("here")
  })

  test("reads a socket's port the way Node does, so a numeric string is a port and not a pipe", () => {
    for (const port of [" 80", "0x50", "80.0", "8e1", "+80", ""])
      expect(() => new net.Socket().connect(port as never, OUTSIDE)).toThrow(EgressGuard.EgressBlocked)
  })

  test("blocks a WebSocket's own proxy when it is not the guard's", () => {
    expect(() => new WebSocket("ws://127.0.0.1:9/", { proxy: `http://${OUTSIDE}:3128` } as never)).toThrow(
      `connection to ${OUTSIDE}`,
    )
  })

  test("decides fetch.preconnect, which does nothing for an outside address", () => {
    const before = state.handle!.attempts().length
    expect(fetch.preconnect(`https://${OUTSIDE}/`)).toBeUndefined()
    expect(state.handle!.attempts().slice(before)).toEqual([
      { kind: "fetch", host: OUTSIDE, port: 443, url: `https://${OUTSIDE}`, method: "CONNECT", allowed: false },
    ])
  })

  test("blocks Bun.connect to an outside address", async () => {
    await expect(
      Bun.connect({ hostname: OUTSIDE, port: 443, socket: { data: () => undefined } }),
    ).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    // Bun reads `host` too when `hostname` is not given.
    await expect(
      Bun.connect({ host: OUTSIDE, port: 443, socket: { data: () => undefined } } as never),
    ).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port!,
      socket: { data: () => undefined },
    })
    socket.end()
  })

  test("installs the same wraps in a Worker, from the global class or node:worker_threads", async () => {
    const file = path.join(os.tmpdir(), `vector-guard-worker-${process.pid}.ts`)
    await Bun.write(
      file,
      `const outcome = (promise) => promise.then(() => "reached", (error) => error?.name ?? String(error))
const results = {
  fetch: await outcome(fetch("http://${OUTSIDE}/w")),
  connect: await outcome(Bun.connect({ hostname: "${OUTSIDE}", port: 80, socket: { data() {} } })),
  native: await Bun.fetch("http://${OUTSIDE}/n").then((response) => response.status),
  here: await fetch("${at()}").then((response) => response.text()),
}
const { parentPort } = await import("node:worker_threads")
if (parentPort) parentPort.postMessage(results)
else postMessage(results)
`,
    )
    const expected = { fetch: "EgressBlocked", connect: "EgressBlocked", native: 403, here: "here" }
    const web = new Worker(file)
    expect(await new Promise<unknown>((resolve) => (web.onmessage = (event) => resolve(event.data)))).toEqual(expected)
    web.terminate()
    const thread = new workerThreads.Worker(file)
    expect(await new Promise<unknown>((resolve) => thread.once("message", resolve))).toEqual(expected)
    await thread.terminate()
  })

  test("guards a worker whose entry imports backstop-worker first, however it was started", async () => {
    const file = path.join(os.tmpdir(), `vector-guard-sealed-${process.pid}.ts`)
    await Bun.write(
      file,
      `import ${JSON.stringify(path.join(import.meta.dir, "../../src/local-mode/backstop-worker.ts"))}
const outcome = (promise) => promise.then(() => "reached", (error) => error?.name ?? String(error))
const { parentPort } = await import("node:worker_threads")
parentPort.postMessage({ connect: await outcome(Bun.connect({ hostname: "${OUTSIDE}", port: 80, socket: { data() {} } })) })
`,
    )
    // The class as a module that imported it by name before the guard kept it: no preload reaches this worker.
    const thread = new original.ThreadWorker(file)
    expect(await new Promise<unknown>((resolve) => thread.once("message", resolve))).toEqual({
      connect: "EgressBlocked",
    })
    await thread.terminate()
  })

  test("refuses a second install and restores every original on uninstall", () => {
    expect(() => EgressGuard.installStrict()).toThrow("already installed")
    state.handle!.uninstall()
    state.handle = undefined
    expect(globalThis.fetch).toBe(original.fetch)
    expect(net.Socket.prototype.connect).toBe(original.connect)
    expect(globalThis.WebSocket).toBe(original.WebSocket)
    expect(globalThis.Worker).toBe(original.Worker)
    expect(workerThreads.Worker).toBe(original.ThreadWorker)
    expect(Bun.connect).toBe(original.connect_)
    expect(Object.hasOwn(http.ClientRequest.prototype, "end")).toBe(false)
    expect(Object.fromEntries(Object.keys(original.env).map((key) => [key, process.env[key]]))).toEqual(original.env)
  })
})

describe("EgressGuard.install with Vector Local on", () => {
  const recorded: EgressGuard.Recorded[] = []
  const listed = LocalPolicy.resolve({ global: { enabled: true, endpoints: ["http://nas.local:8000"] } })
  const current = { policy: LocalPolicy.OFF }
  const state: { handle?: EgressGuard.Handle } = {}
  const errorOf = (socket: { on: (event: string, listener: (...input: unknown[]) => void) => unknown }) =>
    new Promise<unknown>((resolve) => {
      socket.on("error", resolve)
      socket.on("connect", () => resolve("connected"))
      socket.on("response", () => resolve("answered"))
    })
  // What a resolver would answer for any name, without asking DNS.
  const answer =
    (address: string) => (_hostname: string, options: { all?: boolean }, callback: (...input: unknown[]) => void) =>
      options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)
  beforeAll(() => {
    state.handle = EgressGuard.install({ policy: () => current.policy, record: (item) => recorded.push(item) })
  })
  afterAll(() => {
    state.handle?.uninstall()
    state.handle = undefined
  })

  test("passes everything and records nothing while Vector Local is off", async () => {
    current.policy = LocalPolicy.OFF
    expect(await (await fetch(at())).text()).toBe("here")
    expect(state.handle!.attempts()).toEqual([])
    expect(recorded).toEqual([])
  })

  test("blocks an unlabelled connection off this computer before it is made, in every client", async () => {
    current.policy = listed
    await expect(fetch(`http://${OUTSIDE}/`)).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await errorOf(net.connect(443, OUTSIDE))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await errorOf(tls.connect(443, OUTSIDE))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(await errorOf(https.get(`https://${OUTSIDE}/`))).toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(() => new WebSocket(`wss://${OUTSIDE}/`)).toThrow(EgressGuard.EgressBlocked)
    await expect(
      Bun.connect({ host: OUTSIDE, port: 443, socket: { data: () => undefined } } as never),
    ).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
    expect(fetch.preconnect(`https://${OUTSIDE}/`)).toBeUndefined()
    const blocked = recorded.filter((item) => !item.attempt.allowed)
    expect(blocked.map((item) => item.attempt.kind)).toEqual([
      "fetch",
      "socket",
      "socket",
      "http",
      "websocket",
      "socket",
      "fetch",
    ])
    expect(new Set(blocked.map((item) => item.verdict.rule))).toEqual(new Set(["unlabelled"]))
    // The log names the code that made each one.
    expect(blocked.every((item) => item.frame?.includes("guard.test.ts"))).toBe(true)
    expect(state.handle!.attempts().filter((item) => item.host === OUTSIDE && item.allowed)).toEqual([])
  })

  test("lets this computer and the listed servers through, logging only what leaves this computer", async () => {
    current.policy = listed
    recorded.length = 0
    expect(await (await fetch(at())).text()).toBe("here")
    expect(await errorOf(net.connect(server.port!, "127.0.0.1"))).toBe("connected")
    expect(recorded).toEqual([])
    // nas.local is listed; its connection is decided, logged and checked after lookup.
    const listener = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
    const port = (listener.address() as net.AddressInfo).port
    const policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: [`http://nas.local:${port}`] } })
    current.policy = policy
    expect(await errorOf(net.connect({ host: "nas.local", port, lookup: answer("127.0.0.1") as never }))).toBe(
      "connected",
    )
    expect(recorded.map((item) => [item.attempt.host, item.verdict.rule])).toEqual([["nas.local", "listed"]])
    listener.close()
  })

  test("refuses a name that says it is here or on your network but resolves outside, before connecting", async () => {
    current.policy = listed
    recorded.length = 0
    for (const host of ["nas.local", "localhost"]) {
      const error = await errorOf(net.connect({ host, port: 8000, lookup: answer(OUTSIDE) as never }))
      expect(error).toBeInstanceOf(EgressGuard.EgressBlocked)
      expect((error as EgressGuard.EgressBlocked).rule).toBe("resolved-outside")
    }
    expect(recorded.map((item) => [item.attempt.host, item.verdict.rule])).toEqual([
      ["nas.local", "listed"],
      ["nas.local", "resolved-outside"],
      ["localhost", "resolved-outside"],
    ])
  })

  test("lets only the destinations a labelled scope granted through, never an unrelated host", async () => {
    current.policy = listed
    const granted = await EgressAttribution.granted(
      { source: "model-catalog", purpose: "catalog", grants: [{ host: "catalog.web.test", port: server.port }] },
      async () => {
        // The resolver here is the caller's own, so no DNS is asked.
        const reached = await errorOf(
          http.get({ host: "catalog.web.test", port: server.port, path: "/", lookup: answer("127.0.0.1") as never }),
        )
        const other = await errorOf(
          http.get({ host: "other.web.test", port: server.port, path: "/", lookup: answer("127.0.0.1") as never }),
        )
        return { reached, other }
      },
    )
    expect(granted.reached).toBe("answered")
    expect(granted.other).toBeInstanceOf(EgressGuard.EgressBlocked)
    // The same host without the scope is unlabelled.
    expect(
      await errorOf(
        http.get({ host: "catalog.web.test", port: server.port, path: "/", lookup: answer("127.0.0.1") as never }),
      ),
    ).toBeInstanceOf(EgressGuard.EgressBlocked)
  })

  test("stops an unlabelled redirect at the hop that leaves this computer", async () => {
    current.policy = listed
    await expect(fetch(at("/out"))).rejects.toThrow(`connection to ${OUTSIDE}`)
    const followed = await fetch(at("/hop"))
    expect({ url: followed.url, redirected: followed.redirected }).toEqual({ url: at("/landed"), redirected: true })
  })

  test("treats a proxy on this computer as the internet: an unlabelled request cannot use it", async () => {
    current.policy = listed
    const seenByProxy: string[] = []
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seenByProxy.push(request.url)
        return new Response("proxied")
      },
    })
    const saved = ["HTTPS_PROXY", "HTTP_PROXY"].map((key) => [key, process.env[key]] as const)
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    try {
      await expect(fetch("https://models.web.test/v1/models")).rejects.toBeInstanceOf(EgressGuard.EgressBlocked)
      expect(await errorOf(net.connect(proxy.port!, "127.0.0.1"))).toBeInstanceOf(EgressGuard.EgressBlocked)
      await expect(fetch(at(), { proxy: `http://127.0.0.1:${proxy.port}` } as RequestInit)).rejects.toBeInstanceOf(
        EgressGuard.EgressBlocked,
      )
      expect(seenByProxy).toEqual([])
    } finally {
      for (const [key, value] of saved) {
        process.env[key] = value ?? ""
        if (value === undefined) delete process.env[key]
      }
      proxy.stop(true)
    }
  })
})

describe("EgressGuard.environmentProxies", () => {
  const target = (url: string) => new URL(url)
  test("lists every proxy for the scheme and ALL_PROXY, and none for NO_PROXY's hosts", () => {
    const env = { HTTP_PROXY: "http://web-proxy:1", http_proxy: "http://lower:4", ALL_PROXY: "http://all:3" }
    expect(EgressGuard.environmentProxies(target("http://a.example/"), env)).toEqual([
      "http://web-proxy:1",
      "http://lower:4",
      "http://all:3",
    ])
    expect(
      EgressGuard.environmentProxies(target("https://a.example/"), {
        https_proxy: "http://tls:2",
        ALL_PROXY: "http://all:3",
      }),
    ).toEqual(["http://tls:2", "http://all:3"])
    expect(EgressGuard.environmentProxies(target("http://a.example/"), {})).toEqual([])
    for (const [list, url, bypassed] of [
      ["*", "http://a.example/", true],
      ["xample", "http://a.example/", false],
      ["a.example", "http://a.example/", true],
      [".example", "http://deep.a.example/", true],
      ["*.example", "http://a.example/", true],
      ["a.example:8080", "http://a.example/", false],
      ["a.example:8080", "http://a.example:8080/", true],
      ["127.0.0.1, ::1", "http://[::1]:3000/", true],
    ] as const)
      expect({
        list,
        url,
        proxies: EgressGuard.environmentProxies(target(url), { HTTP_PROXY: "http://web-proxy:1", NO_PROXY: list }),
      }).toEqual({ list, url, proxies: bypassed ? [] : ["http://web-proxy:1"] })
  })
})
