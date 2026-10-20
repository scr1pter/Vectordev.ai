import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import workerThreads from "node:worker_threads"
import { EgressGuard } from "../../src/local-mode/guard"

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

  test("blocks Bun.connect to an outside address", async () => {
    await expect(
      Bun.connect({ hostname: OUTSIDE, port: 443, socket: { data: () => undefined } }),
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
