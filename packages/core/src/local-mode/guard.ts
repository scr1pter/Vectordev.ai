export * as EgressGuard from "./guard"

import http from "node:http"
import net from "node:net"
import { fileURLToPath } from "node:url"
import workerThreads from "node:worker_threads"
import { LocalPolicy } from "./policy"

// The backstop under Vector Local's labelled call sites. This is the one place Vector patches globals on purpose, and
// it is installed before anything else in an entry point so no module captures the originals first.
//
// This is the seed: strict mode for tests. A connection that does not stay on this computer throws EgressBlocked
// before it is made, or is refused with 403 by the guard's own proxy. Strict mode covers:
// - fetch: its destination, any proxy it would use (`proxy` in its options or the proxy environment), and every
//   redirect hop, which the wrapper follows itself so each one is decided before it is made;
// - Bun.fetch, a fetch captured before the guard was installed, node:http and a Worker's fetch: the guard points the
//   proxy environment at a proxy of its own on 127.0.0.1, which refuses any destination off this computer;
// - WebSocket, Bun.connect, `net.Socket.prototype.connect` (which net, tls and node:https use) and the start of a
//   node:http client request;
// - Workers started through the global `Worker` or the `node:worker_threads` module object, which preload these
//   same wraps.
// It does not cover a child process that drops the proxy environment, UDP or DNS lookups, a Bun.fetch given a proxy of
// its own, or the sockets of a Worker whose class was imported by name before the guard was installed (its HTTP still
// goes through the guard's proxy). The full backstop (labels, the policy in effect, a decision at every layer) builds
// on it in phase L4.

export class EgressBlocked extends Error {
  override readonly name = "EgressBlocked"
  constructor(
    readonly host: string,
    readonly kind: Attempt["kind"],
  ) {
    super(`Vector blocked a connection to ${host}: only this computer is reachable here.`)
  }
}

export type Attempt = {
  /** `proxied` is a request a client sent through the guard's own proxy. */
  readonly kind: "fetch" | "socket" | "http" | "websocket" | "proxied"
  readonly host: string
  readonly port?: number
  readonly url?: string
  readonly allowed: boolean
}

export type Options = {
  /** Names the caller pins to this computer itself, such as a test resolver's `*.web.test`. */
  readonly names?: readonly string[]
  /**
   * Whether to run the guard's own proxy and point the proxy environment at it. Off in a Worker, which reaches its
   * parent's proxy through the environment it shares.
   */
  readonly proxy?: boolean
}

export type Handle = {
  /** Every connection attempt since the guard was installed, allowed or not. */
  readonly attempts: () => readonly Attempt[]
  /** Restores every original, and the proxy environment as it was. */
  readonly uninstall: () => void
}

/** What a Worker reads to install strict mode too: on, the pinned names, and the parent's proxy. */
export const ENVIRONMENT = {
  strict: "VECTOR_TEST_EGRESS",
  names: "VECTOR_TEST_EGRESS_NAMES",
  proxy: "VECTOR_TEST_EGRESS_PROXY",
} as const

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
const NO_PROXY_VARIABLES = ["NO_PROXY", "no_proxy"]
const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"]
const MAX_HEAD_BYTES = 64 * 1024
const WORKER_PRELOAD = fileURLToPath(new URL("./guard-worker.ts", import.meta.url))

const state: { handle?: Handle } = {}

type Fetch = typeof globalThis.fetch
type FetchInit = RequestInit & { readonly proxy?: string | { readonly url: string }; readonly unix?: string }
type Hop = FetchInit & { readonly method: string; readonly headers: Headers }
type Recorder = (attempt: Omit<Attempt, "allowed">) => EgressBlocked | undefined
type Connect = (this: net.Socket, ...input: unknown[]) => net.Socket
type BunSockets = {
  connect: (options: { readonly hostname?: string; readonly port?: number; readonly unix?: string }) => Promise<unknown>
}
type WorkerOptions = { readonly preload?: string | readonly string[]; readonly env?: unknown }

/**
 * Whether a host stays on this computer: a loopback name or address, or a name the caller pinned there. A name under
 * `localhost` is not counted by its name alone, since a resolver without RFC 6761's rule may answer it from upstream.
 */
export function local(host: string, names: readonly string[] = []) {
  return LocalPolicy.loopback(host) || names.some((name) => LocalPolicy.domainMatches(host, name))
}

/**
 * The proxies a request to `target` may go through under this environment: every variable for its scheme and
 * ALL_PROXY, since clients differ on which spelling wins. Empty when NO_PROXY sends it direct.
 */
export function environmentProxies(target: URL, env: Readonly<Record<string, string | undefined>> = process.env) {
  const secure = target.protocol === "https:" || target.protocol === "wss:"
  const proxies = [
    ...(secure ? [env.HTTPS_PROXY, env.https_proxy] : [env.HTTP_PROXY, env.http_proxy]),
    env.ALL_PROXY,
    env.all_proxy,
  ].filter((value): value is string => Boolean(value))
  if (bypassed(target, secure ? "443" : "80", env.NO_PROXY || env.no_proxy || "")) return []
  return [...new Set(proxies)]
}

/** Installs the guard in strict mode: any connection that leaves this computer is refused before it is made. */
export function installStrict(options: Options = {}): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const names = options.names ?? []
  const attempts: Attempt[] = []
  const record: Recorder = (attempt) => {
    const allowed = local(attempt.host, names)
    attempts.push({ ...attempt, allowed })
    return allowed ? undefined : new EgressBlocked(attempt.host, attempt.kind)
  }
  const check = (attempt: Omit<Attempt, "allowed">) => {
    const blocked = record(attempt)
    if (blocked) throw blocked
  }

  const originalConnect = net.Socket.prototype.connect as unknown as Connect
  const proxy = options.proxy === false ? undefined : startProxy(record, names, originalConnect)
  const ownProxy = proxy?.url ?? process.env[ENVIRONMENT.proxy]
  const saved = [...PROXY_VARIABLES, ...NO_PROXY_VARIABLES, ...Object.values(ENVIRONMENT)].map(
    (key) => [key, process.env[key]] as const,
  )
  const strictEnvironment = {
    [ENVIRONMENT.strict]: "strict",
    [ENVIRONMENT.names]: names.join(","),
    ...(ownProxy && {
      [ENVIRONMENT.proxy]: ownProxy,
      ...Object.fromEntries(PROXY_VARIABLES.map((key) => [key, ownProxy])),
      ...Object.fromEntries(NO_PROXY_VARIABLES.map((key) => [key, ""])),
    }),
  }
  // A Worker writes its own copy too: its fetch reads the environment its thread holds, not the parent's.
  if (ownProxy) Object.assign(process.env, strictEnvironment)

  // Any proxy but the guard's own carries a request off this computer, whatever its target.
  const proxied = (target: URL, init: FetchInit | undefined) => {
    const given = typeof init?.proxy === "string" ? init.proxy : init?.proxy?.url
    const other = (given ? [given] : environmentProxies(target)).find((proxy) => proxy !== ownProxy)
    if (!other) return undefined
    const host = URL.canParse(other) ? new URL(other).hostname : other
    attempts.push({
      kind: "fetch",
      host,
      url: URL.canParse(other) ? new URL(other).origin : undefined,
      allowed: false,
    })
    return new EgressBlocked(host, "fetch")
  }
  const decide = (url: URL, init: FetchInit | undefined) =>
    record({ kind: "fetch", host: url.hostname, url: url.origin }) ?? proxied(url, init)

  const originalFetch = globalThis.fetch
  const follow = async (response: Response, from: URL, hop: Hop, count: number): Promise<Response> => {
    const location = response.headers.get("location")
    if (!REDIRECTS.has(response.status) || location === null) {
      if (count > 0) Object.defineProperty(response, "redirected", { value: true })
      return response
    }
    if (count >= MAX_REDIRECTS) throw new TypeError(`Too many redirects: more than ${MAX_REDIRECTS}.`)
    const next = new URL(location, from)
    if (next.protocol !== "http:" && next.protocol !== "https:")
      throw new TypeError(`A redirect to ${next.protocol} cannot be followed.`)
    await response.body?.cancel()
    const blocked = decide(next, hop)
    if (blocked) throw blocked
    const following = nextHop(hop, response.status, from, next)
    return follow(await originalFetch(next, following), next, following, count + 1)
  }
  const fetch = ((input: Parameters<Fetch>[0], init?: FetchInit) => {
    const target = input instanceof Request ? input.url : String(input)
    // A Unix socket, a data: or blob: URL and an address fetch cannot parse never leave the computer through here.
    if (init?.unix || !URL.canParse(target)) return originalFetch(input, init)
    const url = new URL(target)
    if (!WEB_PROTOCOLS.has(url.protocol)) return originalFetch(input, init)
    const blocked = decide(url, init)
    if (blocked) return Promise.reject(blocked)
    if ((init?.redirect ?? (input instanceof Request ? input.redirect : "follow")) !== "follow")
      return originalFetch(input, init)
    const first: Hop = {
      ...init,
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: init?.body ?? (input instanceof Request ? input.body : null),
      signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
      redirect: "manual",
    }
    return originalFetch(input, { ...init, redirect: "manual" }).then((response) => follow(response, url, first, 0))
  }) as Fetch
  fetch.preconnect = originalFetch.preconnect
  globalThis.fetch = fetch

  const OriginalWebSocket = globalThis.WebSocket
  const GuardedWebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      // An address WebSocket cannot parse fails in its own constructor, with its own error.
      if (URL.canParse(String(url))) {
        const target = new URL(String(url))
        check({ kind: "websocket", host: target.hostname, url: target.origin })
      }
      super(url, protocols)
    }
  }
  globalThis.WebSocket = GuardedWebSocket as typeof globalThis.WebSocket

  const sockets = typeof Bun === "undefined" ? undefined : (Bun as unknown as BunSockets)
  const originalBunConnect = sockets?.connect
  if (sockets && originalBunConnect)
    sockets.connect = (options) => {
      const blocked = options.unix
        ? undefined
        : record({ kind: "socket", host: options.hostname ?? "localhost", port: options.port })
      return blocked ? Promise.reject(blocked) : originalBunConnect(options)
    }

  const socket = net.Socket.prototype as unknown as { connect: unknown }
  socket.connect = function (this: net.Socket, ...args: unknown[]) {
    const destination = socketDestination(args)
    if (destination) check({ kind: "socket", ...destination })
    return originalConnect.apply(this, args)
  }

  // Bun's node:http client goes through its own fetch, past both wraps above, once the request starts.
  const request = http.ClientRequest.prototype as unknown as { [key: string]: unknown }
  const own = Object.fromEntries(
    ["end", "write", "flushHeaders"].map((key) => [key, Object.getOwnPropertyDescriptor(request, key)]),
  )
  const decided = new WeakSet<object>()
  for (const key of ["end", "write", "flushHeaders"]) {
    const original = request[key] as (...input: unknown[]) => unknown
    request[key] = function (this: http.ClientRequest & { socketPath?: string; port?: unknown }, ...args: unknown[]) {
      if (!decided.has(this)) {
        decided.add(this)
        if (!this.socketPath) check({ kind: "http", host: String(this.host ?? "localhost"), port: numberOf(this.port) })
      }
      return original.apply(this, args)
    }
  }

  // A Worker preloads these same wraps, with the names and the proxy it reads from its environment.
  const guarded = (options: WorkerOptions | undefined) => ({
    ...options,
    preload: [WORKER_PRELOAD, ...[options?.preload ?? []].flat()],
    ...(options?.env && typeof options.env === "object" ? { env: { ...options.env, ...strictEnvironment } } : {}),
  })
  const OriginalWorker = globalThis.Worker
  globalThis.Worker = class extends OriginalWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, guarded(options) as never)
    }
  } as typeof globalThis.Worker
  const threads = workerThreads as unknown as { Worker: typeof workerThreads.Worker }
  const OriginalThreadWorker = threads.Worker
  threads.Worker = class extends OriginalThreadWorker {
    constructor(file: string | URL, options?: WorkerOptions) {
      super(file, guarded(options) as never)
    }
  }

  const handle: Handle = {
    attempts: () => [...attempts],
    uninstall: () => {
      globalThis.fetch = originalFetch
      globalThis.WebSocket = OriginalWebSocket
      globalThis.Worker = OriginalWorker
      threads.Worker = OriginalThreadWorker
      if (sockets && originalBunConnect) sockets.connect = originalBunConnect
      socket.connect = originalConnect
      for (const [key, descriptor] of Object.entries(own)) {
        if (descriptor) Object.defineProperty(request, key, descriptor)
        else delete request[key]
      }
      proxy?.stop()
      // Bun's fetch reads the proxy environment at each request, and deleting a variable does not reach it, so a
      // variable that was unset is emptied first.
      if (ownProxy)
        for (const [key, value] of saved) {
          process.env[key] = value ?? ""
          if (value === undefined) delete process.env[key]
        }
      state.handle = undefined
    },
  }
  state.handle = handle
  return handle
}

// The redirect a fetch would follow itself: 303, and 301 or 302 after a POST, become a GET without a body; a body
// is resent only when it can be read twice; Authorization is dropped when the origin changes.
function nextHop(hop: Hop, status: number, from: URL, next: URL): Hop {
  const method = hop.method.toUpperCase()
  const get =
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST")
  const headers = new Headers(hop.headers)
  if (get) BODY_HEADERS.forEach((name) => headers.delete(name))
  if (from.origin !== next.origin) headers.delete("authorization")
  if (!get && hop.body != null && !replayable(hop.body))
    throw new TypeError("A redirect that resends a streamed request body cannot be followed.")
  return { ...hop, method: get ? "GET" : hop.method, body: get ? null : hop.body, headers }
}

function replayable(body: BodyInit) {
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof URLSearchParams ||
    body instanceof FormData
  )
}

// NO_PROXY's entries: `*`, a name (which covers the names under it), `.name` or `*.name`, each with an optional port.
function bypassed(target: URL, port: string, list: string) {
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const at = target.port || port
  return list
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true
      const name = entry.toLowerCase()
      // An IPv6 address without brackets has no port.
      const parsed =
        name.split(":").length > 2 && !name.startsWith("[") ? [name, name] : /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(name)
      if (!parsed?.[1] || (parsed[2] && parsed[2] !== at)) return false
      const base = parsed[1].replace(/^\*?\./, "")
      return host === base || host.endsWith(`.${base}`)
    })
}

// The guard's own proxy, for the clients its wraps cannot reach. Each request a client sends it is decided on its own,
// a later one on a kept-alive connection included: a destination off this computer is refused with 403, and otherwise
// the proxy connects there, passes the request and its body, and relays the response. It never keeps a test alive.
function startProxy(record: Recorder, names: readonly string[], connect: Connect) {
  const server = net.createServer((client) => {
    const current: { upstream?: net.Socket } = {}
    client.on("error", () => client.destroy())
    client.on("close", () => current.upstream?.destroy())
    const serve = (head: string, rest: Buffer) => {
      // The client sent its next request, so it has read all of the last response.
      current.upstream?.destroy()
      const [line = "", ...fields] = head.split("\r\n")
      const [method = "", target = "", version = "HTTP/1.1"] = line.split(" ")
      const tunnel = method.toUpperCase() === "CONNECT"
      const destination = tunnel ? authority(target) : absolute(target)
      if (!destination) return refuse(client, 400, "Bad Request", "The guard's proxy reads absolute http URLs only.")
      const blocked = record({ kind: "proxied", host: destination.host, port: destination.port, url: destination.url })
      if (blocked) return refuse(client, 403, "Forbidden", blocked.message)
      const upstream = new net.Socket()
      current.upstream = upstream
      const connected = { done: false }
      upstream.on("error", () => {
        if (!connected.done) return refuse(client, 502, "Bad Gateway", `Could not reach ${destination.host}.`)
        if (current.upstream === upstream) client.destroy()
      })
      // A name the caller pinned to this computer is reached on 127.0.0.1, as its resolver would answer.
      const pinned = names.some((name) => LocalPolicy.domainMatches(destination.host, name))
      connect.call(upstream, destination.port, pinned ? "127.0.0.1" : destination.host, () => {
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
    }
    readHead(client, serve)
  })
  server.listen(0, "127.0.0.1")
  server.unref()
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The egress guard's proxy could not start.")
  return { url: `http://127.0.0.1:${address.port}`, stop: () => server.close() }
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

type Destination = { readonly host: string; readonly port: number; readonly url: string; readonly path?: string }

// CONNECT's `host:port`, with an IPv6 address in brackets.
function authority(target: string): Destination | undefined {
  if (!URL.canParse(`http://${target}`)) return undefined
  const url = new URL(`http://${target}`)
  const port = Number(url.port || 443)
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, url: `https://${url.host}` }
}

function absolute(target: string): Destination | undefined {
  if (!URL.canParse(target)) return undefined
  const url = new URL(target)
  if (url.protocol !== "http:") return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "")
  return { host, port: Number(url.port || 80), url: url.origin, path: `${url.pathname}${url.search}` }
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

function refuse(client: net.Socket, status: number, reason: string, message: string) {
  client.end(
    `HTTP/1.1 ${status} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`,
  )
}

// `connect(options, listener)`, `connect(port, host, listener)`, `connect(path, listener)`, or the normalized
// `[options, listener]` array Node and Bun pass from `net.connect`. A Unix socket or a Windows pipe stays local.
function socketDestination(args: readonly unknown[]): { host: string; port?: number } | undefined {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof first === "string" && !/^\d+$/.test(first)) return undefined
  if (typeof first === "number" || typeof first === "string")
    return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) }
  if (!first || typeof first !== "object") return undefined
  const options = first as { path?: unknown; host?: unknown; port?: unknown }
  if (options.path) return undefined
  return {
    host: typeof options.host === "string" && options.host ? options.host : "localhost",
    port: numberOf(options.port),
  }
}

function numberOf(value: unknown) {
  const port = Number(value)
  return Number.isFinite(port) ? port : undefined
}
