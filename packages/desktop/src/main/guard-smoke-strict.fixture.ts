// The strict test guard under Node, bundled for Node and run there by guard-smoke.test.ts with
// VECTOR_TEST_EGRESS=strict, as a test of the desktop's engine would run. Its first import installs the guard the way
// every entry point does. Under Node the strict guard runs no proxy of its own: fetch, node:https and a fetch taken
// before install all connect through net, which it wraps. It prints what each client got as one line of JSON.
import "@vectordevai/core/local-mode/backstop"
import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { Worker } from "node:worker_threads"
import { EgressGuard } from "@vectordevai/core/local-mode/guard"

// A documentation address (TEST-NET-2): never routed.
const OUTSIDE = "198.51.100.7"

const server = http.createServer((_request, response) => response.end("here"))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const here = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`

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
// Strict mode throws where a socket or request is made, which rejects too.
const made = (make: () => { on: (event: string, listener: (...input: unknown[]) => void) => unknown }) =>
  outcome(
    new Promise((resolve, reject) => {
      const emitter = make()
      emitter.on("error", reject)
      emitter.on("connect", resolve)
      emitter.on("response", resolve)
    }),
  )

const results = {
  runtime: process.versions.bun ? "bun" : `node ${process.versions.node}`,
  installed: EgressGuard.installed(),
  proxyEnvironment: process.env.HTTP_PROXY ?? null,
  fetch: await outcome(fetch(`http://${OUTSIDE}/`)),
  https: await made(() => https.get(`https://${OUTSIDE}/`)),
  net: await made(() => net.connect(443, OUTSIDE)),
  here: await (await fetch(here)).text(),
  worker: await new Promise<unknown>((resolve) => {
    const code = readFileSync(new URL("./guard-smoke.worker.mjs", import.meta.url), "utf8")
    const thread = new Worker(code, { eval: true })
    thread.once("message", (message) => {
      resolve(message)
      void thread.terminate()
    })
    thread.once("error", (error) => resolve(`worker error: ${error.message}`))
  }),
}

server.close()
process.stdout.write(`guard-smoke ${JSON.stringify(results)}\n`, () => process.exit(0))
