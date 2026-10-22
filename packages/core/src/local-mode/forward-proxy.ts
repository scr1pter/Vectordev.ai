export * as ForwardProxy from "./forward-proxy"

import net from "node:net"

// An HTTP forward proxy on 127.0.0.1 that decides each request a client sends it on its own, a later one on a
// kept-alive connection included: CONNECT tunnels (https, wss) and absolute-form http requests. A refused request is
// answered with its status and a plain-text reason. An allowed one is connected where the decision says, and its
// request and body are passed on and the response relayed. It never keeps a process alive. The strict test guard and
// the research browsers' egress proxy are both built on it.

export type Destination = {
  readonly host: string
  readonly port: number
  /** The origin, `https://host:port` for a tunnel. */
  readonly url: string
  readonly tunnel: boolean
  /** The request's method: CONNECT for a tunnel. */
  readonly method: string
  readonly path?: string
}

export type Refusal = { readonly status: number; readonly reason: string; readonly message: string }

/** Where an allowed request goes: `connect` starts the upstream socket and calls `connected` once it is open. */
export type Route =
  | { readonly connect: (connected: () => void) => net.Socket; readonly refuse?: undefined }
  | { readonly refuse: Refusal; readonly connect?: undefined }

export type Proxy = { readonly url: string; readonly port: number; readonly stop: () => Promise<void> }

const MAX_HEAD_BYTES = 64 * 1024

export const FORBIDDEN = (message: string): Route => ({ refuse: { status: 403, reason: "Forbidden", message } })

/**
 * Starts the proxy on an ephemeral port of 127.0.0.1. It is listening when this returns: Bun and Node bind a TCP
 * server synchronously, which the strict guard relies on while it installs.
 */
export function start(decide: (destination: Destination) => Route | Promise<Route>): Proxy {
  // Every open connection, so stopping the proxy also ends the tunnels and requests it is carrying.
  const open = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const current: { upstream?: net.Socket } = {}
    open.add(client)
    client.on("error", () => client.destroy())
    client.on("close", () => {
      open.delete(client)
      current.upstream?.destroy()
    })
    const serve = (head: string, rest: Buffer) => {
      // The client sent its next request, so it has read all of the last response. The last upstream is let go first,
      // so its end does not close the client while this request is still being decided.
      const previous = current.upstream
      current.upstream = undefined
      previous?.destroy()
      const [line = "", ...fields] = head.split("\r\n")
      const [method = "", target = "", version = "HTTP/1.1"] = line.split(" ")
      const tunnel = method.toUpperCase() === "CONNECT"
      const parsed = tunnel ? authority(target) : absolute(target)
      const destination = parsed && { ...parsed, method: method.toUpperCase() }
      if (!destination)
        return refuse(client, {
          status: 400,
          reason: "Bad Request",
          message: "This proxy reads absolute http URLs only.",
        })
      const relay = (connect: (connected: () => void) => net.Socket) => {
        const connected = { done: false }
        const upstream = connect(() => {
          connected.done = true
          if (tunnel) {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
            if (rest.length > 0) upstream.write(rest)
            client.pipe(upstream)
            upstream.pipe(client)
            client.resume()
            return
          }
          upstream.write(originForm(method, destination, version, fields))
          upstream.pipe(client, { end: false })
          upstream.on("end", () => {
            if (current.upstream === upstream) client.end()
          })
          // Only this request's body goes on to this destination; the bytes after it are the client's next request.
          forwardBody(client, upstream, fields, rest, (next) => readHead(client, serve, next))
        })
        current.upstream = upstream
        upstream.on("error", (error: unknown) => {
          if (connected.done) {
            if (current.upstream === upstream) client.destroy()
            return
          }
          // A refusal the network guard made after a lookup reads as one, not as an unreachable host.
          const blocked = error instanceof Error && error.name === "EgressBlocked"
          refuse(client, {
            status: blocked ? 403 : 502,
            reason: blocked ? "Forbidden" : "Bad Gateway",
            message: blocked ? error.message : `Could not reach ${destination.host}.`,
          })
        })
      }
      Promise.resolve()
        .then(() => decide(destination))
        .then(
          (route) => (route.refuse ? refuse(client, route.refuse) : relay(route.connect)),
          () => refuse(client, { status: 502, reason: "Bad Gateway", message: `Could not reach ${destination.host}.` }),
        )
    }
    readHead(client, serve)
  })
  server.listen(0, "127.0.0.1")
  server.unref()
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The proxy could not start.")
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop: () =>
      new Promise<void>((done) => {
        server.close(() => done())
        open.forEach((socket) => socket.destroy())
      }),
  }
}

function readHead(client: net.Socket, done: (head: string, rest: Buffer) => void, first: Buffer = Buffer.alloc(0)) {
  const chunks: Buffer[] = [first]
  const take = (chunk?: Buffer) => {
    if (chunk) chunks.push(chunk)
    const all = Buffer.concat(chunks)
    const end = all.indexOf("\r\n\r\n")
    if (end < 0 && all.length < MAX_HEAD_BYTES) return false
    client.off("data", take)
    client.pause()
    if (end < 0) client.destroy()
    if (end >= 0) done(all.subarray(0, end).toString("latin1"), all.subarray(end + 4))
    return true
  }
  if (first.length > 0 && take()) return
  client.on("data", take)
  client.resume()
}

// Passes a request's body on, framed by its Content-Length or its chunks, and hands back what follows it.
function forwardBody(
  client: net.Socket,
  upstream: net.Socket,
  fields: readonly string[],
  first: Buffer,
  done: (next: Buffer) => void,
) {
  const header = (name: string) =>
    fields
      .find((field) => field.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() ?? ""
  const read = /\bchunked\b/i.test(header("transfer-encoding"))
    ? chunked()
    : length(Number(header("content-length")) || 0)
  const feed = (chunk: Buffer) => {
    const taken = read(chunk)
    if (taken.used > 0) upstream.write(chunk.subarray(0, taken.used))
    if (!taken.finished) return false
    client.off("data", feed)
    client.pause()
    done(chunk.subarray(taken.used))
    return true
  }
  if (feed(first)) return
  client.on("data", feed)
  client.resume()
}

function length(bytes: number) {
  const state = { left: bytes }
  return (chunk: Buffer) => {
    const used = Math.min(state.left, chunk.length)
    state.left -= used
    return { used, finished: state.left === 0 }
  }
}

// Chunked encoding: a hex size line, that many bytes and CRLF, until a zero size and the trailers' empty line.
function chunked() {
  const state = { phase: "size" as "size" | "data" | "trailer", line: "", left: 0 }
  return (chunk: Buffer) => {
    const at = { index: 0 }
    while (at.index < chunk.length) {
      if (state.phase === "data") {
        const taken = Math.min(state.left, chunk.length - at.index)
        at.index += taken
        state.left -= taken
        if (state.left === 0) Object.assign(state, { phase: "size", line: "" })
        continue
      }
      const byte = chunk[at.index++]!
      if (byte !== 0x0a) {
        state.line += String.fromCharCode(byte)
        continue
      }
      const line = state.line.replace(/\r$/, "")
      state.line = ""
      if (state.phase === "trailer" && line === "") return { used: at.index, finished: true }
      if (state.phase === "trailer") continue
      // The CRLF after a chunk's data reads here as an empty size line.
      if (line === "") continue
      const size = Number.parseInt(line.split(";")[0] ?? "", 16)
      if (!Number.isFinite(size) || size < 0) return { used: at.index, finished: true }
      if (size === 0) state.phase = "trailer"
      if (size > 0) Object.assign(state, { phase: "data", left: size })
    }
    return { used: at.index, finished: false }
  }
}

// CONNECT's `host:port`, with an IPv6 address in brackets.
function authority(target: string): Omit<Destination, "method"> | undefined {
  if (!URL.canParse(`http://${target}`)) return undefined
  const url = new URL(`http://${target}`)
  const port = Number(url.port || 443)
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, url: `https://${url.host}`, tunnel: true }
}

function absolute(target: string): Omit<Destination, "method"> | undefined {
  if (!URL.canParse(target)) return undefined
  const url = new URL(target)
  if (url.protocol !== "http:") return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "")
  return { host, port: Number(url.port || 80), url: url.origin, tunnel: false, path: `${url.pathname}${url.search}` }
}

// The request as its server expects it: the path alone, no proxy headers, and closed after one response unless it
// upgrades, so a kept-alive connection never carries a later request to another destination.
function originForm(method: string, destination: Destination, version: string, fields: readonly string[]) {
  const upgrade = fields.some((field) => /^upgrade\s*:/i.test(field))
  const kept = fields.filter(
    (field) =>
      !/^(?:proxy-connection|proxy-authorization|keep-alive)\s*:/i.test(field) &&
      (upgrade || !/^connection\s*:/i.test(field)),
  )
  const host = fields.some((field) => /^host\s*:/i.test(field)) ? [] : [`Host: ${new URL(destination.url).host}`]
  return `${method} ${destination.path ?? "/"} ${version}\r\n${[...host, ...kept, ...(upgrade ? [] : ["Connection: close"])].join("\r\n")}\r\n\r\n`
}

// The refusal, then the connection is closed once it is sent: nothing else is read from a client that was refused.
function refuse(client: net.Socket, refusal: Refusal) {
  client.end(
    `HTTP/1.1 ${refusal.status} ${refusal.reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(refusal.message)}\r\nconnection: close\r\n\r\n${refusal.message}`,
    () => client.destroy(),
  )
}
