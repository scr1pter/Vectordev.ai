export * as EgressGuard from "./guard"

import http from "node:http"
import net from "node:net"
import { LocalPolicy } from "./policy"

// The backstop under Vector Local's labelled call sites. It wraps the ways a process opens a connection: fetch,
// WebSocket, `net.Socket.prototype.connect` (which Node's http, https and tls use, and Bun's tls) and the start of a
// `node:http` client request (which Bun sends through its own fetch, past the socket). This is the one place Vector
// patches globals on purpose, and it is installed before anything else in an entry point so no module captures the
// originals first.
//
// This is the seed: strict mode for tests, where any connection that does not stay on this computer throws
// EgressBlocked. The full backstop (labels, the policy in effect, proxies, redirects, Bun.connect) builds on it.

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
  readonly kind: "fetch" | "socket" | "http" | "websocket"
  readonly host: string
  readonly port?: number
  readonly url?: string
  readonly allowed: boolean
}

export type Options = {
  /** Names the caller pins to this computer itself, such as a test resolver's `*.web.test`. */
  readonly names?: readonly string[]
}

export type Handle = {
  /** Every connection attempt since the guard was installed, allowed or not. */
  readonly attempts: () => readonly Attempt[]
  /** Restores every original. */
  readonly uninstall: () => void
}

const state: { handle?: Handle } = {}

/** Whether a host stays on this computer: a loopback name or address, or a name the caller pinned there. */
export function local(host: string, names: readonly string[] = []) {
  return LocalPolicy.loopback(host) || names.some((name) => LocalPolicy.domainMatches(host, name))
}

/** Installs the guard in strict mode: any connection that leaves this computer throws before it is made. */
export function installStrict(options: Options = {}): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const names = options.names ?? []
  const attempts: Attempt[] = []
  const record = (attempt: Omit<Attempt, "allowed">) => {
    const allowed = local(attempt.host, names)
    attempts.push({ ...attempt, allowed })
    return allowed ? undefined : new EgressBlocked(attempt.host, attempt.kind)
  }
  const check = (attempt: Omit<Attempt, "allowed">) => {
    const blocked = record(attempt)
    if (blocked) throw blocked
  }

  const originalFetch = globalThis.fetch
  const fetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const target = input instanceof Request ? input.url : String(input)
    // A Unix socket, a data: or blob: URL and an address fetch cannot parse never leave the computer through here.
    const unix = Boolean(init && "unix" in init && init.unix)
    if (!unix && URL.canParse(target)) {
      const url = new URL(target)
      if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") {
        const blocked = record({ kind: "fetch", host: url.hostname, url: url.origin })
        if (blocked) return Promise.reject(blocked)
      }
    }
    return originalFetch(input, init)
  }) as typeof globalThis.fetch
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

  const socket = net.Socket.prototype as unknown as Record<string, unknown>
  const originalConnect = net.Socket.prototype.connect
  socket.connect = function (this: net.Socket, ...args: unknown[]) {
    const destination = socketDestination(args)
    if (destination) check({ kind: "socket", ...destination })
    return (originalConnect as (...input: unknown[]) => net.Socket).apply(this, args)
  }

  // Bun's node:http client goes through its own fetch, past both wraps above, once the request starts.
  const request = http.ClientRequest.prototype as unknown as Record<string, unknown>
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

  const handle: Handle = {
    attempts: () => [...attempts],
    uninstall: () => {
      globalThis.fetch = originalFetch
      globalThis.WebSocket = OriginalWebSocket
      socket.connect = originalConnect
      for (const [key, descriptor] of Object.entries(own)) {
        if (descriptor) Object.defineProperty(request, key, descriptor)
        else delete request[key]
      }
      state.handle = undefined
    },
  }
  state.handle = handle
  return handle
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
