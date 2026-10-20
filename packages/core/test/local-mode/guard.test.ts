import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { EgressGuard } from "../../src/local-mode/guard"

// A documentation address (TEST-NET-2): never routed, so a guard that failed to block would hang, not reach anyone.
const OUTSIDE = "198.51.100.7"

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("here") })
afterAll(() => server.stop(true))

describe("EgressGuard.local", () => {
  test("counts loopback in every spelling as this computer", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "app.localhost",
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
    for (const host of [OUTSIDE, "10.0.0.5", "192.168.1.2", "100.64.0.1", "example.com", "127.0.0.1.example.com", ""])
      expect({ host, local: EgressGuard.local(host) }).toEqual({ host, local: false })
  })

  test("counts names the caller pins to this computer", () => {
    expect(EgressGuard.local("article.web.test", ["web.test"])).toBe(true)
    expect(EgressGuard.local("web.test.example.com", ["web.test"])).toBe(false)
  })
})

describe("EgressGuard.installStrict", () => {
  const state: { handle?: EgressGuard.Handle } = {}
  const original = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect, WebSocket: globalThis.WebSocket }
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
    expect(new Set(kinds)).toEqual(new Set(["fetch", "http", "socket"]))
  })

  test("refuses a second install and restores every original on uninstall", () => {
    expect(() => EgressGuard.installStrict()).toThrow("already installed")
    state.handle!.uninstall()
    state.handle = undefined
    expect(globalThis.fetch).toBe(original.fetch)
    expect(net.Socket.prototype.connect).toBe(original.connect)
    expect(globalThis.WebSocket).toBe(original.WebSocket)
    expect(Object.hasOwn(http.ClientRequest.prototype, "end")).toBe(false)
  })
})
