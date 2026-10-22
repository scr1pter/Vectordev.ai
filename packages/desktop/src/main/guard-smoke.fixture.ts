// The body of guard-smoke.test.ts, bundled for Node and run there: the desktop's engine and main process run on Node
// (Electron's utility process and main process), where fetch, WebSocket, node:https and the ws package all go through
// Node's own sockets. It installs the backstop the way an entry point does, with Vector Local on, and prints what each
// client got as one line of JSON. Nothing here leaves this computer: refused connections are refused before they
// connect, and the others go to servers on 127.0.0.1.
import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import { createRequire } from "node:module"
import net from "node:net"
import { Worker } from "node:worker_threads"
import { EgressAttribution } from "@vectordevai/core/local-mode/attribution"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressProxy } from "@vectordevai/core/local-mode/egress-proxy"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"

// A documentation address (TEST-NET-2): never routed.
const OUTSIDE = "198.51.100.7"
const CAPTURED_PORT = 8081
// Taken before the guard is installed, as a module that kept its own copy would.
const capturedFetch = globalThis.fetch
const CapturedWebSocket = globalThis.WebSocket

const server = http.createServer((request, response) => {
  if (request.url === "/out") {
    response.writeHead(302, { location: `http://${OUTSIDE}/collect` })
    return response.end()
  }
  response.end("here")
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as net.AddressInfo).port
const here = `http://127.0.0.1:${port}`
// A proxy on this computer that answers every request itself, as a corporate proxy would forward it.
const seenByProxy: string[] = []
const proxy = http.createServer((request, response) => {
  seenByProxy.push(`${request.method} ${request.url}`)
  response.end("proxied")
})
// Node's fetch reaches a proxy through a tunnel even for http, and this one answers inside it.
proxy.on("connect", (request: http.IncomingMessage, socket: net.Socket) => {
  seenByProxy.push(`CONNECT ${request.url}`)
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
  socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 7\r\nconnection: close\r\n\r\nproxied"))
})
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const proxyPort = (proxy.address() as net.AddressInfo).port

const handle = Egress.backstop()
Egress.configure(
  LocalPolicy.resolve({
    global: {
      enabled: true,
      endpoints: [here],
      allow: [{ source: "model-catalog", hosts: ["catalog.web.test"], reason: "Prices", added_at: 1, added_by: "app" }],
    },
  }),
)

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "reached",
    (error: unknown) =>
      error instanceof Error
        ? error.name === "TypeError" && error.cause instanceof Error
          ? error.cause.name
          : error.name
        : String(error),
  )
const socketOutcome = (socket: { on: (event: string, listener: (...input: unknown[]) => void) => unknown }) =>
  new Promise<string>((resolve) => {
    socket.on("error", (error) => resolve(error instanceof Error ? error.name : String(error)))
    socket.on("connect", () => resolve("connected"))
    socket.on("response", () => resolve("answered"))
  })
const thrown = (make: () => unknown) => {
  const result = { name: "reached" }
  try {
    make()
  } catch (error) {
    result.name = error instanceof Error ? error.name : String(error)
  }
  return result.name
}
const answer =
  (address: string) => (_hostname: string, options: { all?: boolean }, callback: (...input: unknown[]) => void) =>
    options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4)
// What a raw client of a proxy on this computer reads back, as a browser would send it.
const raw = (port: number, text: string) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = []
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text))
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()))
    socket.on("error", () => resolve(Buffer.concat(chunks).toString()))
  })
// The ws package from the engine's dependencies, which the test names; under Node it connects through net.
const WebSocketClient = process.env.GUARD_SMOKE_WS
  ? (createRequire(import.meta.url)(process.env.GUARD_SMOKE_WS) as new (url: string) => {
      on: (event: string, listener: (error: Error) => void) => void
    })
  : undefined
// The research browsers' proxy, as desktop main will start it, with its secret.
const SECRET = "guard-smoke-research-proxy-secret"
const CREDENTIALS = `Proxy-Authorization: Basic ${Buffer.from(`vector:${SECRET}`).toString("base64")}\r\n`
const research = await EgressProxy.start({
  secret: SECRET,
  resolver: async () => [{ address: "127.0.0.1", family: 4 }],
  privateHosts: ["web.test"],
})
const ask = (auth: string) =>
  raw(
    research.port,
    `GET http://article.web.test:${port}/ HTTP/1.1\r\nHost: article.web.test:${port}\r\n${auth}Connection: close\r\n\r\n`,
  )

const results: Record<string, unknown> = {
  runtime: process.versions.bun ? "bun" : `node ${process.versions.node}`,
  electron: process.versions.electron ?? null,
  fetch: await outcome(fetch(`http://${OUTSIDE}/`)),
  capturedFetch: await outcome(capturedFetch(`http://${OUTSIDE}/`)),
  https: await socketOutcome(https.get(`https://${OUTSIDE}/`)),
  net: await socketOutcome(net.connect(443, OUTSIDE)),
  webSocket: thrown(() => new WebSocket(`wss://${OUTSIDE}/`)),
  // A refusal and an unreachable address both read as `error` to a WebSocket, so the guard's own list says which it
  // was: its own port, so no other client's attempt counts.
  capturedWebSocket: await new Promise<string>((resolve) => {
    const socket = new CapturedWebSocket(`ws://${OUTSIDE}:${CAPTURED_PORT}/`)
    socket.onerror = () => resolve("error")
    socket.onopen = () => resolve("reached")
  }).then((outcome) => ({
    outcome,
    refused: (handle?.attempts() ?? []).some(
      (attempt) => attempt.host === OUTSIDE && attempt.port === CAPTURED_PORT && !attempt.allowed,
    ),
  })),
  here: await (await fetch(here)).text(),
  capturedHere: await (await capturedFetch(here)).text(),
  redirect: await outcome(fetch(`${here}/out`)),
  labelled: await EgressAttribution.granted(
    { source: "model-catalog", purpose: "catalog", grants: [{ host: "catalog.web.test", port }] },
    () => socketOutcome(http.get({ host: "catalog.web.test", port, path: "/", lookup: answer("127.0.0.1") as never })),
  ),
  unlabelled: await socketOutcome(
    http.get({ host: "catalog.web.test", port, path: "/", lookup: answer("127.0.0.1") as never }),
  ),
  resolvedOutside: await socketOutcome(net.connect({ host: "localhost", port, lookup: answer(OUTSIDE) as never })),
  ws: WebSocketClient
    ? await new Promise<string>((resolve) => {
        const socket = new WebSocketClient(`ws://${OUTSIDE}/`)
        socket.on("error", (error) => resolve(error.name))
        socket.on("open", () => resolve("reached"))
      })
    : "no ws package",
  // The brain's background reader starts this way; its first import guards it.
  worker: await new Promise<unknown>((resolve) => {
    const thread = new Worker(readFileSync(new URL("./guard-smoke.worker.mjs", import.meta.url), "utf8"), {
      eval: true,
    })
    thread.once("message", (message) => {
      resolve(message)
      void thread.terminate()
    })
    thread.once("error", (error) => resolve(`worker error: ${error.message}`))
  }),
  // Its status line without the secret, and the page's body with it.
  researchProxy: [(await ask("")).split("\r\n")[0], (await ask(CREDENTIALS)).split("\r\n\r\n")[1]],
}
await research.stop()

// With the proxy environment on, as the desktop's engine sets it, an unlabelled connection to the proxy is the
// internet, and a labelled request goes through it.
process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`
// Node 24's own switch for the proxy environment, which the desktop's engine turns on (sidecar.ts).
;(http as typeof http & { setGlobalProxyFromEnv: () => void }).setGlobalProxyFromEnv()
results.proxyUnlabelled = await socketOutcome(net.connect(proxyPort, "127.0.0.1"))
results.proxyUnlabelledFetch = await outcome(fetch("http://catalog.web.test/models"))
const viaProxy = await Egress.fetch("model-catalog", "http://catalog.web.test/models").then(
  (response) => response.text(),
  (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
)
results.proxyLabelled = viaProxy
// A model call to a listed server on this computer, and an unlabelled request there, go direct, never to the proxy.
results.proxyLocalInference = await Egress.fetch("local-inference", `${here}/v1/chat/completions`, {
  method: "POST",
  body: "secret prompt",
}).then((response) => response.text())
results.proxyLoopbackFetch = await (await fetch(`${here}/v1`)).text()
// Node's node:http agent read the proxy environment once, so its request for this computer is refused at the socket.
results.proxyLoopbackHttp = await socketOutcome(http.get(`${here}/v1`))
results.seenByProxy = seenByProxy
results.blocked = Egress.events({ blocked: true }).map((event) => [event.source, event.rule])

handle?.uninstall()
server.close()
proxy.close()
process.stdout.write(`guard-smoke ${JSON.stringify(results)}\n`, () => process.exit(0))
