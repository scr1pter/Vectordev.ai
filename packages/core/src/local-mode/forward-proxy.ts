export * as ForwardProxy from "./forward-proxy"

import { timingSafeEqual } from "node:crypto"
import net from "node:net"

// An HTTP forward proxy on 127.0.0.1 that decides each request a client sends it on its own, a later one on a
// kept-alive connection included: CONNECT tunnels (https, wss) and absolute-form http requests. A refused request is
// answered with its status and a plain-text reason. An allowed one is connected where the decision says, and its
// request and body are passed on and the response relayed; the connection then waits for the client's next request
// when the response's end can be told, and closes otherwise (`responseHead`). It never keeps a process alive. The strict test guard and the research browsers' egress proxy are both built on it.
// A request that upgrades (a WebSocket over plain http) becomes a tunnel once its server answers 101, and a client
// must send its first request within HEAD_TIMEOUT.
//
// With a secret, only a client that sends it may use the proxy: any program on this computer can reach loopback, the
// ones the agent runs included, so an open proxy would be a way around the network guard.

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

export type Refusal = {
  readonly status: number
  readonly reason: string
  readonly message: string
  /** Header lines the answer carries besides its own. */
  readonly headers?: readonly string[]
}

/** Where an allowed request goes: `connect` starts the upstream socket and calls `connected` once it is open. */
export type Route =
  | { readonly connect: (connected: () => void) => net.Socket; readonly refuse?: undefined }
  | { readonly refuse: Refusal; readonly connect?: undefined }

export type Proxy = { readonly url: string; readonly port: number; readonly stop: () => Promise<void> }

export type Options = {
  /**
   * A per-launch secret each request must carry as the password of Basic `Proxy-Authorization` credentials (any user
   * name). A request without it, or with another, is answered 407 before anything about it is decided. The
   * credentials are never passed on, and an upstream's 407 is answered as 502, so a client is never asked for the
   * secret on a site's behalf.
   */
  readonly secret?: string
  /** How long a client may take to send its first request's head before its connection is closed. */
  readonly headTimeout?: number
}

type Decide = (destination: Destination) => Route | Promise<Route>

const MAX_HEAD_BYTES = 64 * 1024
const HEAD_TIMEOUT = 30_000
// How long a kept-alive connection may wait for its client's next request. It keeps no process alive meanwhile.
const KEEP_ALIVE = 300_000
const AUTHENTICATE = 'Proxy-Authenticate: Basic realm="Vector", charset="UTF-8"'

export const FORBIDDEN = (message: string): Route => ({ refuse: { status: 403, reason: "Forbidden", message } })

/** Starts the proxy on an ephemeral port of 127.0.0.1, and resolves once it is listening. */
export function start(decide: Decide, options: Options = {}): Promise<Proxy> {
  const made = create(decide, options)
  return new Promise((resolve, reject) => {
    made.server.once("error", reject)
    made.server.listen(0, "127.0.0.1", () => {
      made.server.off("error", reject)
      resolve(made.proxy())
    })
  })
}

/**
 * Starts the proxy and returns it listening, for the strict test guard, which installs synchronously. Only Bun binds a
 * server before `listen` returns; Node looks the host up first and binds later, so under Node this throws.
 */
export function startSync(decide: Decide, options: Options = {}): Proxy {
  const made = create(decide, options)
  made.server.listen(0, "127.0.0.1")
  if (made.server.address()) return made.proxy()
  made.server.close()
  throw new Error("The proxy could not start here: this runtime binds a server only after listen returns.")
}

function create(decide: Decide, options: Options) {
  // Every open connection, so stopping the proxy also ends the tunnels and requests it is carrying.
  const open = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const current: { upstream?: net.Socket; idle?: ReturnType<typeof setTimeout> } = {}
    open.add(client)
    client.on("error", () => client.destroy())
    client.on("close", () => {
      open.delete(client)
      clearTimeout(current.idle)
      current.upstream?.destroy()
    })
    // A response whose end the client can tell leaves its connection open for the client's next request, whatever the
    // response said: Bun's fetch sends one on it after a refused answer (4xx, 5xx, a redirect) even when told to close.
    const idle = () => {
      clearTimeout(current.idle)
      client.unref()
      current.idle = setTimeout(() => client.destroy(), KEEP_ALIVE)
      current.idle.unref()
    }
    const serve = (head: string, rest: Buffer) => {
      clearTimeout(current.idle)
      client.ref()
      // The client sent its next request, so it has read all of the last response. The last upstream is let go first,
      // so its end does not close the client while this request is still being decided.
      const previous = current.upstream
      current.upstream = undefined
      previous?.destroy()
      const [line = "", ...fields] = head.split("\r\n")
      if (options.secret !== undefined && !authorized(fields, options.secret))
        return refuse(client, {
          status: 407,
          reason: "Proxy Authentication Required",
          message: "This proxy is only for Vector's own browsers.",
          headers: [AUTHENTICATE],
        })
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
          const response = { framed: false }
          // The upstream closes after one response. A response without a length or chunks ends only with the
          // connection, so the client's is closed too; otherwise it waits for the client's next request.
          upstream.on("end", () => {
            if (current.upstream !== upstream) return
            if (!response.framed) return client.end()
            idle()
          })
          // A request that asks to upgrade (a WebSocket over plain http) becomes a tunnel to this destination once it
          // answers 101: the client's bytes after the request are the new protocol's, not another request.
          const upgrade: { asked: boolean; status?: string; next?: Buffer } = {
            asked: fields.some((field) => /^upgrade\s*:/i.test(field)),
          }
          const settle = () => {
            if (upgrade.status === undefined || upgrade.next === undefined) return
            if (upgrade.status !== "101") return readHead(client, serve, upgrade.next)
            if (upgrade.next.length > 0) upstream.write(upgrade.next)
            client.pipe(upstream)
            client.resume()
          }
          responseHead(
            upstream,
            destination.method,
            (interim) => client.write(interim),
            (status, read, framed) => {
              response.framed = framed
              // With a secret, a site's 407 would read as this proxy asking for it again.
              if (status === "407" && options.secret !== undefined) {
                // Let go first, so a body still on its way to it does not close the client before the answer is sent.
                current.upstream = undefined
                upstream.destroy()
                return refuse(client, {
                  status: 502,
                  reason: "Bad Gateway",
                  message: `${destination.host} asked for proxy credentials, which this proxy never passes on.`,
                })
              }
              client.write(read)
              upstream.pipe(client, { end: false })
              if (!upgrade.asked) return
              upgrade.status = status ?? ""
              settle()
            },
          )
          // Only this request's body goes on to this destination; the bytes after it are the client's next request.
          forwardBody(client, upstream, fields, rest, (next) => {
            if (!upgrade.asked) return readHead(client, serve, next)
            upgrade.next = next
            settle()
          })
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
    // A client that never finishes its first request would hold its connection open; one with the secret has sent it
    // in that request.
    const waiting = setTimeout(() => client.destroy(), options.headTimeout ?? HEAD_TIMEOUT)
    waiting.unref()
    client.on("close", () => clearTimeout(waiting))
    readHead(client, (head, rest) => {
      clearTimeout(waiting)
      serve(head, rest)
    })
  })
  server.unref()
  return {
    server,
    proxy: (): Proxy => {
      const port = (server.address() as net.AddressInfo).port
      return {
        url: `http://127.0.0.1:${port}`,
        port,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            open.forEach((socket) => socket.destroy())
          }),
      }
    },
  }
}

// Basic credentials whose password is the secret, compared in constant time.
function authorized(fields: readonly string[], secret: string) {
  const value = fields.find((field) => /^proxy-authorization\s*:/i.test(field))?.replace(/^[^:]*:\s*/, "") ?? ""
  const [scheme = "", token = ""] = value.split(/\s+/)
  const decoded = Buffer.from(token, "base64").toString("utf8")
  if (scheme.toLowerCase() !== "basic" || !decoded.includes(":")) return false
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1))
  const expected = Buffer.from(secret)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Reads an upstream response until its head is in, then hands back its status, the bytes to send the client and
// whether the client can tell where the response ends without the connection closing (`framed`), with the upstream
// paused. The bytes are the head, then whatever of the body came with it. The upstream's own connection fields are
// about its hop, which closes after this response, so they are dropped: a framed response keeps the client's connection
// open for its next request, and any other says `Connection: close`, since the client's connection then closes with the
// upstream's. An interim head (100 Continue) goes to the client at once, since a client may wait for it before it sends
// its body. A head longer than MAX_HEAD_BYTES, and a 101 that switches protocols, are passed on as they are.
function responseHead(
  upstream: net.Socket,
  method: string,
  interim: (head: Buffer) => void,
  done: (status: string | undefined, read: Buffer, framed: boolean) => void,
) {
  const chunks: Buffer[] = []
  const take = (chunk: Buffer) => {
    chunks.push(chunk)
    const all = Buffer.concat(chunks)
    const end = all.indexOf("\r\n\r\n")
    if (end < 0 && all.length < MAX_HEAD_BYTES) return
    const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(all.toString("latin1", 0, 64))?.[1]
    if (end >= 0 && status?.startsWith("1") && status !== "101") {
      interim(all.subarray(0, end + 4))
      chunks.length = 0
      const rest = all.subarray(end + 4)
      if (rest.length > 0) take(rest)
      return
    }
    upstream.off("data", take)
    upstream.pause()
    if (end < 0 || status === "101") return done(status, all, false)
    const [line = "", ...fields] = all.subarray(0, end).toString("latin1").split("\r\n")
    const ends = framed(status, method, fields)
    const kept = fields.filter((field) => !/^(?:connection|keep-alive|proxy-connection)\s*:/i.test(field))
    const head = [line, ...kept, ...(ends ? [] : ["Connection: close"])].join("\r\n")
    done(status, Buffer.concat([Buffer.from(head, "latin1"), all.subarray(end)]), ends)
  }
  upstream.on("data", take)
}

// Whether a response's end is known without its connection closing: it has no body (HEAD, 204, 304), or a length or
// chunks.
function framed(status: string | undefined, method: string, fields: readonly string[]) {
  if (method === "HEAD" || status === "204" || status === "304") return true
  return fields.some(
    (field) => /^content-length\s*:\s*\d+\s*$/i.test(field) || /^transfer-encoding\s*:.*\bchunked\b/i.test(field),
  )
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
  const headers = (refusal.headers ?? []).map((line) => `${line}\r\n`).join("")
  client.end(
    `HTTP/1.1 ${refusal.status} ${refusal.reason}\r\n${headers}content-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(refusal.message)}\r\nconnection: close\r\n\r\n${refusal.message}`,
    () => client.destroy(),
  )
}
