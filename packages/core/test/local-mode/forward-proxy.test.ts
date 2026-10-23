import { afterAll, describe, expect, test } from "bun:test"
import net from "node:net"
import { ForwardProxy } from "../../src/local-mode/forward-proxy"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

// The forward proxy itself, under its two users' decisions: a guard that refuses a connection as it is made, and the
// count of what it passed to its clients, which the research browsers bound a page load by. Its clients write raw
// requests, as a browser does; every connection stays on this computer.

const guard = NetworkGuard.use()
// More than one read's worth, sent in chunks with no Content-Length.
const BODY = 256 * 1024
const web = FakeWeb.start({
  sites: {
    article: {
      "/": { body: "article" },
      "/stream": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              Array.from({ length: 4 }, () => controller.enqueue(new Uint8Array(BODY / 4).fill(97)))
              controller.close()
            },
          }),
        ),
    },
  },
})
afterAll(() => web.close())

const send = (port: number, text: string) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text))
    const done = () => resolve(Buffer.concat(chunks).toString())
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("end", done)
    socket.on("error", reject)
    setTimeout(() => {
      socket.destroy()
      done()
    }, 1_500)
  })
const get = (port: number, url: string) => send(port, `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n\r\n`)

describe("ForwardProxy", () => {
  test("answers a client when the guard refuses the connection as it is made", async () => {
    const blocked = await ForwardProxy.start(() => ({
      connect: () => {
        throw Object.assign(new Error("Vector Local blocks journal.example."), { name: "EgressBlocked" })
      },
    }))
    const failing = await ForwardProxy.start(() => ({
      connect: () => {
        throw new Error("no route")
      },
    }))
    try {
      // The guard's refusal reads as one, with its reason, not as an unreachable site.
      const refused = await get(blocked.port, "http://journal.example/article")
      expect(refused).toStartWith("HTTP/1.1 403 Forbidden")
      expect(refused).toContain("Vector Local blocks journal.example.")
      const tunnel = await send(
        blocked.port,
        "CONNECT journal.example:443 HTTP/1.1\r\nHost: journal.example:443\r\n\r\n",
      )
      expect(tunnel).toStartWith("HTTP/1.1 403 Forbidden")
      // Any other failure as the connection is made reads as an unreachable site.
      const unreachable = await get(failing.port, "http://journal.example/article")
      expect(unreachable).toStartWith("HTTP/1.1 502 Bad Gateway")
      expect(unreachable).toContain("Could not reach journal.example.")
      expect(unreachable).not.toContain("no route")
    } finally {
      await blocked.stop()
      await failing.stop()
    }
  })

  test("counts what it passed to its clients as the bytes arrive, a chunked answer included, after they close too", async () => {
    const target = new URL(web.url("article", "/stream"))
    const proxy = await ForwardProxy.start(() => ({
      connect: (connected) => net.connect(Number(target.port), "127.0.0.1", connected),
    }))
    try {
      expect(proxy.received()).toBe(0)
      const answer = await get(proxy.port, target.toString())
      expect(answer).toContain("Transfer-Encoding: chunked")
      expect(answer).not.toMatch(/content-length/i)
      // The body and the framing around it.
      const counted = proxy.received()
      expect(counted).toBeGreaterThan(BODY)
      expect(counted).toBeLessThan(BODY + 4_096)
      // A refusal it answers itself counts too.
      const refusing = await ForwardProxy.start(() => ForwardProxy.FORBIDDEN("Not this one."))
      const refused = await get(refusing.port, "http://journal.example/")
      expect(refusing.received()).toBe(Buffer.byteLength(refused))
      await refusing.stop()
    } finally {
      await proxy.stop()
    }
    expect(guard.outside()).toEqual([])
  })
})
