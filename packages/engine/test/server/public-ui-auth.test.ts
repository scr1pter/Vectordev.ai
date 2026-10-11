import { describe, expect, test } from "bun:test"
import { connect } from "node:net"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Server } from "../../src/server/server"

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            VECTOR_SERVER_USERNAME: "vector",
            VECTOR_SERVER_PASSWORD: "secret",
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (path: string, init?: RequestInit) =>
    Promise.resolve(handler(new Request(new URL(path, "http://localhost"), init), HttpApiApp.context))
}

describe("public UI authentication boundary", () => {
  test("allows UI bootstrap while keeping documentation and APIs authenticated", async () => {
    const request = app()
    const [ui, queryCredential, asset, doc, api] = await Promise.all([
      request("/"),
      request("/?auth_token=secret"),
      request("/site.webmanifest"),
      request("/doc"),
      request("/api/session"),
    ])

    expect(ui.status).not.toBe(401)
    expect(queryCredential.status).toBe(401)
    expect(asset.status).not.toBe(401)
    expect(doc.status).toBe(401)
    expect(api.status).toBe(401)
  })
})

test("a path the URL parser reads as a public asset does not open /doc", async () => {
  const previous = process.env.VECTOR_SERVER_PASSWORD
  process.env.VECTOR_SERVER_PASSWORD = "secret"
  const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
  const origin = new URL(listener.url)
  // fetch resolves '..' before sending, so the request goes over a raw socket the way a client could send it.
  const status = (target: string) =>
    new Promise<number>((resolve, reject) => {
      const socket = connect(Number(origin.port), origin.hostname)
      let head = ""
      socket.on("data", (chunk) => {
        head += chunk.toString()
        if (!head.includes("\r\n")) return
        socket.destroy()
        resolve(Number(head.split(" ")[1]))
      })
      socket.on("error", reject)
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${origin.host}\r\nConnection: close\r\n\r\n`)
    })
  try {
    // The router serves /doc for this target; the URL parser reads it as /site.webmanifest.
    expect(await status("/doc;/../site.webmanifest")).toBe(401)
    expect(await status("/doc")).toBe(401)
    // The router stops at ';', while URL normalisation turns the suffix into a PTY connect path.
    for (const target of [
      "/api/session;/../pty/pty_probe/connect?ticket=forged",
      "/api/session;/../pty/pty_probe/connect/?ticket=forged",
      "/API/SESSION;/../pty/pty_probe/connect?ticket=forged",
      "/session;/../pty/pty_probe/connect?ticket=forged",
    ])
      expect({ target, status: await status(target) }).toEqual({ target, status: 401 })
    for (const target of ["/pty/pty_probe/connect?ticket=forged", "/API/PTY/pty_probe/CONNECT/?ticket=forged"])
      expect({ target, status: await status(target) }).toEqual({ target, status: 403 })

    expect(await status("/site.webmanifest")).not.toBe(401)
  } finally {
    await listener.stop(true)
    if (previous === undefined) delete process.env.VECTOR_SERVER_PASSWORD
    else process.env.VECTOR_SERVER_PASSWORD = previous
  }
}, 30_000)
