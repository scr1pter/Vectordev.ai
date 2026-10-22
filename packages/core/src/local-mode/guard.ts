export * as EgressGuard from "./guard"

import dns from "node:dns"
import http from "node:http"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"
import { fileURLToPath } from "node:url"
import workerThreads from "node:worker_threads"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { EgressAttribution } from "./attribution"
import { ForwardProxy } from "./forward-proxy"
import { LocalPolicy } from "./policy"

// The backstop under Vector Local's labelled call sites. This is the one place Vector patches globals on purpose. It is
// the first import of every entry point (the CLI, the TUI's engine thread, the desktop's engine and main process, and
// the brain's background reader), so no module captures an original before it is wrapped.
//
// It wraps fetch (and fetch.preconnect), WebSocket, Bun.connect, `net.Socket.prototype.connect` (which net, tls,
// node:https and Node's own fetch use) and, under Bun, the start of a node:http client request, whose client goes
// through Bun's native fetch past the other wraps. Each connection is decided by its destination before it is made:
// - A labelled call site (Egress.fetch, EgressHttpClient, the research browsers' proxy) decides its own request and
//   runs it in an attribution scope that grants that request's destinations; only those pass as that request, so
//   code that runs inside an inherited scope cannot reach an unrelated host.
// - Anything else is purpose `unknown`: with Vector Local on it reaches only this computer and the model servers on
//   the list, and is otherwise blocked and logged with the first stack frame outside this file.
// - fetch follows redirects itself, so every hop is decided before it is made.
// - A proxy is decided as a way off this computer: fetch is decided on its target URL before it reaches a proxy, and
//   at the socket layer a connection to a configured proxy (HTTP(S)_PROXY, ALL_PROXY, a fetch's `proxy` option) counts
//   as the internet, so an unlabelled request through a corporate proxy is still blocked. Node only uses the proxy
//   environment once `http.setGlobalProxyFromEnv` ran; treating the proxy as the internet is right either way.
// - A name allowed because its name says where it is (`localhost`, `nas.local`, `box.tail1.ts.net`) must resolve
//   there: a socket's lookup that answers outside is refused before anything connects, and fetch and Bun.connect
//   look the name up first.
// With Vector Local off, each wrap costs one call and logs nothing.
//
// Strict mode, for tests (VECTOR_TEST_EGRESS=strict), refuses any connection off this computer and throws. It also runs
// a proxy of its own on 127.0.0.1 and points the proxy environment at it, so Bun.fetch, a fetch captured before the
// guard was installed, node:http and a Worker's fetch are refused too, and it preloads its wraps in Workers started
// through the global `Worker` or the `node:worker_threads` module object.
//
// Neither mode covers:
// - UDP and DNS lookups themselves, and the connections of child processes (the programs the agent runs make their
//   own; in strict mode a child that keeps the proxy environment has its HTTP refused, but not its raw sockets);
// - Bun.fetch and a fetch or WebSocket class captured before install, outside strict mode (in strict mode Bun.fetch
//   and a captured fetch go through the guard's proxy, but a captured WebSocket class connects directly, since Bun's
//   WebSocket does not read the proxy environment);
// - a Bun.connect captured before install, including `import { connect } from "bun"`;
// - Bun.SQL (postgres) and Bun.RedisClient, which connect natively;
// - in strict mode, Bun.fetch once a test sets NO_PROXY or a proxy variable of its own after install;
// - under Bun, a Worker class imported by name from node:worker_threads (`import { Worker } from ...`), even in a
//   module loaded after install, since Bun does not update named imports of built-in modules. Its fetch still goes
//   through the strict proxy. A worker entry that imports `backstop-worker.ts` first, as the brain's reader does, is
//   guarded however it was started. Under Node, named imports loaded after install see the wrapped class;
// - under Bun, the lookup of a name a node:http client request uses: that request is decided by its name only.

export class EgressBlocked extends Error {
  override readonly name = "EgressBlocked"
  constructor(
    readonly host: string,
    readonly kind: Attempt["kind"],
    readonly rule?: LocalMode.Rule,
    reason?: string,
  ) {
    super(
      reason
        ? `Vector Local blocked a connection to ${host}. ${reason}`
        : `Vector blocked a connection to ${host}: only this computer is reachable here.`,
    )
  }
}

export type Attempt = {
  /** `proxied` is a request a client sent through the strict guard's own proxy. */
  readonly kind: "fetch" | "socket" | "http" | "websocket" | "proxied"
  readonly host: string
  readonly port?: number
  /** The origin, never the path or query. */
  readonly url?: string
  readonly method?: string
  readonly allowed: boolean
}

/** A connection the guard decided itself while Vector Local is on, for the network log. */
export type Recorded = {
  readonly attempt: Attempt
  readonly verdict: LocalPolicy.Verdict
  readonly scope: EgressAttribution.Scope | undefined
  /** For a blocked connection: the first stack frame outside the guard. */
  readonly frame?: string
}

export type Options = {
  /** The policy in effect, read at every connection. */
  readonly policy: () => LocalMode.Policy
  /** Gets each connection the guard decided itself, except the ones it allowed to this computer. */
  readonly record?: (input: Recorded) => void
}

export type StrictOptions = {
  /** Names the caller pins to this computer itself, such as a test resolver's `*.web.test`. */
  readonly names?: readonly string[]
  /**
   * Whether to run the guard's own proxy and point the proxy environment at it. Off in a Worker, which reaches its
   * parent's proxy through the environment it shares.
   */
  readonly proxy?: boolean
  /**
   * Whether a refused socket, node:http request or WebSocket throws where it is made (the default, for tests) or fails
   * the way a refused connection does, with an `error` event: a worker thread that makes no connections of its own
   * uses that.
   */
  readonly throws?: boolean
}

export type Handle = {
  /** Every connection attempt since the guard was installed (the last 2,000), allowed or not. */
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
export const MAX_REDIRECTS = 20
const MAX_ATTEMPTS = 2_000
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"]
const WORKER_PRELOAD = fileURLToPath(new URL("./guard-worker.ts", import.meta.url))
const RESOLVED_OUTSIDE = "Its name says it is on this computer or your network, but it resolved to an address outside."
const PROXY_HOP =
  "It is a proxy, which can pass a request anywhere; only a request a part of Vector labelled may use it."
// Only this guard's own frames are skipped when the log names the code that made a blocked connection.
const OWN_FRAME = /local-mode[\\/](?:guard|attribution|egress|http-client|forward-proxy)\.[jt]s/

// One guard per process, shared by every copy of this module a bundle loads: the desktop's engine carries its own copy
// of core beside the one its entry point imports first.
const KEY = Symbol.for("vector.egress.guard")
const holder = globalThis as unknown as { [KEY]?: { handle?: Handle } }
const state = (holder[KEY] ??= {})

type Fetch = typeof globalThis.fetch
type FetchInit = RequestInit & { readonly proxy?: string | { readonly url: string }; readonly unix?: string }
export type Hop = FetchInit & { readonly method: string; readonly headers: Headers }
type Connect = (this: net.Socket, ...input: unknown[]) => net.Socket
type BunConnectOptions = {
  readonly hostname?: string
  readonly host?: string
  readonly port?: number
  readonly unix?: string
}
type BunSockets = { connect: (options: BunConnectOptions) => Promise<unknown> }
type Preconnect = (target: string | URL, options?: unknown) => void
type WorkerOptions = { readonly preload?: string | readonly string[]; readonly env?: unknown }
type Lookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) => void
type Judged = { readonly blocked?: EgressBlocked; readonly within?: EgressAttribution.Within }
type Judge = (attempt: Omit<Attempt, "allowed">) => Judged

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

/**
 * Where a name that is allowed by its name alone must resolve: loopback for `localhost`, the private ranges for a
 * name on the user's network, and those plus Tailscale's 100.64.0.0/10 for a `*.ts.net` name. Undefined for an
 * address, and for a name whose place its name does not say.
 */
export function within(host: string): EgressAttribution.Within | undefined {
  const name = LocalPolicy.host(host)
  if (!name || net.isIP(name)) return undefined
  const place = LocalPolicy.hostClass(name)
  if (place === "this-computer") return "loopback"
  if (place === "your-network") return name.endsWith(".ts.net") ? "tailnet" : "private"
  return undefined
}

/** Whether a resolved address is where `within` says its name must be. */
export function inside(address: string, place: EgressAttribution.Within) {
  const found = LocalPolicy.hostClass(address)
  if (place === "loopback") return found === "this-computer"
  if (found === "this-computer" || found === "your-network") return true
  const octets = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address)
  return place === "tailnet" && Number(octets?.[1]) === 100 && Number(octets?.[2]) >= 64 && Number(octets?.[2]) <= 127
}

/** The hosts and ports a request to `url` connects to: its own, and any proxy that would carry it. */
export function destinations(url: URL, proxy?: FetchInit["proxy"]) {
  const given = typeof proxy === "string" ? proxy : proxy?.url
  const proxies = (given ? [given] : environmentProxies(url))
    .filter((item) => URL.canParse(item))
    .map((item) => new URL(item))
  return [
    { host: url.hostname, port: portOf(url), within: within(url.hostname) },
    ...proxies.map((item) => ({ host: item.hostname, port: portOf(item) })),
  ] satisfies EgressAttribution.Grant[]
}

export function installed() {
  return state.handle !== undefined
}

/**
 * Installs the backstop: every connection is decided under the policy `options.policy` returns at that moment. A
 * refused fetch or Bun.connect rejects with EgressBlocked; a refused socket or node:http request fails with it as its
 * `error` event, the way a refused connection does; a refused WebSocket throws.
 */
export function install(options: Options): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const attempts: Attempt[] = []
  const judge: Judge = (attempt) => {
    const policy = options.policy()
    const scope = EgressAttribution.current()
    const grant = scope?.grants?.find((item) => sameHost(item.host, attempt.host) && samePort(item.port, attempt.port))
    if (grant) return keep(attempts, { ...attempt, allowed: true }, { within: grant.within })
    const verdict = socketVerdict(policy, attempt)
    const allowed = verdict.decision === "allow"
    const outcome = { ...attempt, allowed }
    if (!allowed || verdict.class !== "this-computer")
      options.record?.({ attempt: outcome, verdict, scope, ...(allowed ? {} : { frame: frame() }) })
    if (!allowed)
      return keep(attempts, outcome, {
        blocked: new EgressBlocked(attempt.host, attempt.kind, verdict.rule, verdict.reason),
      })
    return keep(attempts, outcome, { within: within(attempt.host) })
  }
  // A name that resolved outside where it said it was is logged as its own refusal.
  const outside = (attempt: Omit<Attempt, "allowed">) => {
    const blocked = new EgressBlocked(attempt.host, attempt.kind, "resolved-outside", RESOLVED_OUTSIDE)
    options.record?.({
      attempt: { ...attempt, allowed: false },
      verdict: {
        decision: "block",
        rule: "resolved-outside",
        class: LocalPolicy.hostClass(attempt.host),
        reason: RESOLVED_OUTSIDE,
        allowable: false,
      },
      scope: EgressAttribution.current(),
      frame: frame(),
    })
    return blocked
  }
  // Only the explicit `proxy` option needs a decision of its own: the proxy environment is the user's, and the request
  // was decided on its target before it reaches that proxy.
  const proxied = (_target: URL, init: FetchInit | undefined) => {
    const given = typeof init?.proxy === "string" ? init.proxy : init?.proxy?.url
    if (!given || !URL.canParse(given)) return undefined
    const proxy = new URL(given)
    return judgeHop({ kind: "fetch", host: proxy.hostname, port: portOf(proxy), url: proxy.origin })
  }
  // A proxy: only a request a labelled call site granted it to may use it.
  const judgeHop = (attempt: Omit<Attempt, "allowed">): EgressBlocked | undefined => {
    const scope = EgressAttribution.current()
    if (scope?.grants?.some((item) => sameHost(item.host, attempt.host) && samePort(item.port, attempt.port))) return
    const verdict: LocalPolicy.Verdict = {
      decision: "block",
      rule: "unlabelled",
      class: "internet",
      reason: PROXY_HOP,
      allowable: false,
    }
    options.record?.({ attempt: { ...attempt, allowed: false }, verdict, scope, frame: frame() })
    keep(attempts, { ...attempt, allowed: false }, {})
    return new EgressBlocked(attempt.host, attempt.kind, "unlabelled", PROXY_HOP)
  }
  const socketJudge: Judge = (attempt) => {
    if (configuredProxy(attempt.host, attempt.port)) {
      const blocked = judgeHop(attempt)
      return blocked ? { blocked } : {}
    }
    return judge(attempt)
  }
  return wrap({
    active: () => options.policy().enabled,
    judge,
    socketJudge,
    proxied,
    outside,
    throws: false,
    attempts,
  })
}

/** Installs the guard in strict mode: any connection that leaves this computer is refused before it is made. */
export function installStrict(options: StrictOptions = {}): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const names = options.names ?? []
  const attempts: Attempt[] = []
  const judge: Judge = (attempt) => {
    const allowed = local(attempt.host, names)
    return keep(
      attempts,
      { ...attempt, allowed },
      allowed ? {} : { blocked: new EgressBlocked(attempt.host, attempt.kind) },
    )
  }

  const originalConnect = net.Socket.prototype.connect as unknown as Connect
  const proxy =
    options.proxy === false
      ? undefined
      : ForwardProxy.start((destination) => {
          const judged = judge({
            kind: "proxied",
            host: destination.host,
            port: destination.port,
            url: destination.url,
          })
          if (judged.blocked) return ForwardProxy.FORBIDDEN(judged.blocked.message)
          // A name the caller pinned to this computer is reached on 127.0.0.1, as its resolver would answer.
          const pinned = names.some((name) => LocalPolicy.domainMatches(destination.host, name))
          return {
            connect: (connected) => {
              const upstream = new net.Socket()
              originalConnect.call(upstream, destination.port, pinned ? "127.0.0.1" : destination.host, connected)
              return upstream
            },
          }
        })
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
    const other = (given ? [given] : environmentProxies(target)).find((item) => item !== ownProxy)
    if (!other) return undefined
    const host = URL.canParse(other) ? new URL(other).hostname : other
    keep(
      attempts,
      { kind: "fetch", host, url: URL.canParse(other) ? new URL(other).origin : undefined, allowed: false },
      {},
    )
    return new EgressBlocked(host, "fetch")
  }
  const handle = wrap({
    active: () => true,
    judge,
    socketJudge: judge,
    proxied,
    outside: (attempt) => new EgressBlocked(attempt.host, attempt.kind),
    throws: options.throws !== false,
    attempts,
    worker: strictEnvironment,
    stop: () => {
      proxy?.stop()
      // Bun's fetch reads the proxy environment at each request, and deleting a variable does not reach it, so a
      // variable that was unset is emptied first.
      if (ownProxy)
        for (const [key, value] of saved) {
          process.env[key] = value ?? ""
          if (value === undefined) delete process.env[key]
        }
    },
  })
  return handle
}

/**
 * The redirect a fetch would follow itself: 303, and 301 or 302 after a POST, become a GET without a body; a body
 * is resent only when it can be read twice; Authorization is dropped when the origin changes.
 */
export function redirectHop(hop: Hop, status: number, from: URL, next: URL): Hop {
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

/** Whether a response is a redirect fetch would follow, and where to. */
export function redirectTarget(response: Response, from: URL) {
  const location = response.headers.get("location")
  if (!REDIRECTS.has(response.status) || location === null) return undefined
  const next = new URL(location, from)
  if (next.protocol !== "http:" && next.protocol !== "https:")
    throw new TypeError(`A redirect to ${next.protocol} cannot be followed.`)
  return next
}

/** The first hop of a fetch call, as `redirectHop` reads it. */
export function firstHop(input: Parameters<Fetch>[0], init: FetchInit | undefined): Hop {
  const request = input instanceof Request ? input : undefined
  return {
    ...init,
    method: init?.method ?? request?.method ?? "GET",
    headers: new Headers(init?.headers ?? request?.headers),
    body: init?.body ?? request?.body ?? null,
    signal: init?.signal ?? request?.signal,
    redirect: "manual",
  }
}

type Wrap = {
  /** Whether connections are decided at all; false passes every call straight through. */
  readonly active: () => boolean
  readonly judge: Judge
  /** The judge for raw sockets, which also see the proxies a client was configured with. */
  readonly socketJudge: Judge
  readonly proxied: (target: URL, init: FetchInit | undefined) => EgressBlocked | undefined
  readonly outside: (attempt: Omit<Attempt, "allowed">) => EgressBlocked
  readonly throws: boolean
  readonly attempts: Attempt[]
  /** Strict mode's environment, which every Worker it sees started gets with the guard preloaded. */
  readonly worker?: Readonly<Record<string, string>>
  readonly stop?: () => void
}

function wrap(input: Wrap): Handle {
  const originalFetch = globalThis.fetch
  // Bun's fetch has preconnect; Node's has none, and gets none.
  const originalPreconnect = (originalFetch as { preconnect?: Preconnect }).preconnect
  // A name allowed by its name alone is looked up first; one that resolves outside is refused before fetch runs.
  const resolved = async (attempt: Omit<Attempt, "allowed">, place: EgressAttribution.Within | undefined) => {
    if (!place) return undefined
    const addresses = await dns.promises.lookup(bare(attempt.host), { all: true }).catch(() => undefined)
    // A name that does not resolve fails in fetch itself, with its own error.
    if (!addresses) return undefined
    return addresses.every((item) => inside(item.address, place)) ? undefined : input.outside(attempt)
  }
  const decide = (url: URL, init: FetchInit | undefined, method: string) => {
    const attempt = { kind: "fetch" as const, host: url.hostname, port: portOf(url), url: url.origin, method }
    const judged = input.judge(attempt)
    return { attempt, judged, blocked: judged.blocked ?? input.proxied(url, init) }
  }
  // An allowed unlabelled request runs with its own destinations granted, so the socket it opens through Node's fetch,
  // or the proxy that carries it, passes as this request.
  const send = (target: URL, init: FetchInit | undefined, run: () => Promise<Response>) => {
    const scope = EgressAttribution.current()
    return EgressAttribution.granted(
      {
        source: scope?.source ?? "unlabelled",
        purpose: scope?.purpose ?? "unknown",
        grants: [...(scope?.grants ?? []), ...destinations(target, init?.proxy)],
      },
      run,
    )
  }
  const follow = async (response: Response, from: URL, hop: Hop, count: number): Promise<Response> => {
    const next = redirectTarget(response, from)
    if (!next) {
      if (count > 0) Object.defineProperty(response, "redirected", { value: true })
      return response
    }
    if (count >= MAX_REDIRECTS) throw new TypeError(`Too many redirects: more than ${MAX_REDIRECTS}.`)
    await response.body?.cancel()
    const following = redirectHop(hop, response.status, from, next)
    const checked = decide(next, following, following.method)
    if (checked.blocked) throw checked.blocked
    const outside = await resolved(checked.attempt, checked.judged.within)
    if (outside) throw outside
    return follow(await send(next, following, () => originalFetch(next, following)), next, following, count + 1)
  }
  const fetch = ((target: Parameters<Fetch>[0], init?: FetchInit) => {
    if (!input.active()) return originalFetch(target, init)
    const address = target instanceof Request ? target.url : String(target)
    // A Unix socket, a data: or blob: URL and an address fetch cannot parse never leave the computer through here.
    if (init?.unix || !URL.canParse(address)) return originalFetch(target, init)
    const url = new URL(address)
    if (!WEB_PROTOCOLS.has(url.protocol)) return originalFetch(target, init)
    const first = firstHop(target, init)
    const checked = decide(url, init, first.method)
    if (checked.blocked) return Promise.reject(checked.blocked)
    const mode = init?.redirect ?? (target instanceof Request ? target.redirect : "follow")
    return resolved(checked.attempt, checked.judged.within).then((outside) => {
      if (outside) throw outside
      if (mode !== "follow") return send(url, init, () => originalFetch(target, init))
      return send(url, init, () => originalFetch(target, { ...init, redirect: "manual" })).then((response) =>
        follow(response, url, first, 0),
      )
    })
  }) as Fetch
  // Preconnecting opens a connection, and for https sends the name, so it is decided too; a refused one does nothing.
  if (originalPreconnect)
    (fetch as { preconnect?: Preconnect }).preconnect = (target, options) => {
      if (!input.active() || !URL.canParse(String(target))) return originalPreconnect(target, options)
      if (decide(new URL(String(target)), undefined, "CONNECT").blocked) return
      return originalPreconnect(target, options)
    }
  globalThis.fetch = fetch

  // A runtime without a global WebSocket (Node before 22) has none to wrap.
  const OriginalWebSocket = globalThis.WebSocket as typeof globalThis.WebSocket | undefined
  if (OriginalWebSocket) globalThis.WebSocket = guardedWebSocket(OriginalWebSocket, input)

  // Read from globalThis, so this module also type-checks and runs where there is no Bun.
  const sockets = (globalThis as unknown as { Bun?: BunSockets }).Bun
  const originalBunConnect = sockets?.connect
  if (sockets && originalBunConnect)
    sockets.connect = (options) => {
      if (!input.active() || options.unix) return originalBunConnect(options)
      // Bun reads `hostname` first and then `host`.
      const attempt = {
        kind: "socket" as const,
        host: options.hostname ?? options.host ?? "localhost",
        port: options.port,
      }
      const judged = input.socketJudge(attempt)
      if (judged.blocked) return Promise.reject(judged.blocked)
      return resolved(attempt, judged.within).then((outside) =>
        outside ? Promise.reject(outside) : originalBunConnect(options),
      )
    }

  const originalConnect = net.Socket.prototype.connect as unknown as Connect
  const socket = net.Socket.prototype as unknown as { connect: unknown }
  socket.connect = function (this: net.Socket, ...args: unknown[]) {
    if (!input.active()) return originalConnect.apply(this, args)
    const destination = socketDestination(args)
    if (!destination) return originalConnect.apply(this, args)
    const attempt = { kind: "socket" as const, ...destination }
    const judged = input.socketJudge(attempt)
    if (judged.blocked) return refuse(this, judged.blocked, input.throws)
    if (!judged.within || net.isIP(bare(destination.host))) return originalConnect.apply(this, args)
    return originalConnect.apply(
      this,
      checkedLookup(args, judged.within, () => input.outside(attempt)),
    )
  }

  // Bun's node:http client goes through its own fetch, past both wraps above, once the request starts. Under Node the
  // request's socket goes through the socket wrap instead.
  const request = http.ClientRequest.prototype as unknown as { [key: string]: unknown }
  const methods = process.versions.bun ? ["end", "write", "flushHeaders"] : []
  const own = Object.fromEntries(methods.map((key) => [key, Object.getOwnPropertyDescriptor(request, key)]))
  const decided = new WeakSet<object>()
  for (const key of methods) {
    const original = request[key] as (...input: unknown[]) => unknown
    request[key] = function (this: http.ClientRequest & { socketPath?: string; port?: unknown }, ...args: unknown[]) {
      if (!input.active() || decided.has(this) || this.socketPath) return original.apply(this, args)
      decided.add(this)
      const judged = input.judge({
        kind: "http",
        host: String(this.host ?? "localhost"),
        port: numberOf(this.port),
        method: this.method,
      })
      if (!judged.blocked) return original.apply(this, args)
      if (input.throws) throw judged.blocked
      // Bun's request emits nothing when it is destroyed before it starts, so the refusal is its error event.
      const blocked = judged.blocked
      process.nextTick(() => {
        this.emit("error", blocked)
        this.destroy()
      })
      return key === "write" ? false : this
    }
  }

  // Strict mode preloads these same wraps in every Worker it sees started, with the names and the proxy it reads from
  // its environment. Under Node, named imports of node:worker_threads loaded after this see the wrapped class too.
  const threads = workerThreads as unknown as { Worker: typeof workerThreads.Worker }
  const OriginalWorker = globalThis.Worker
  const OriginalThreadWorker = threads.Worker
  const worker = input.worker
  if (worker) {
    const guarded = (options: WorkerOptions | undefined) => ({
      ...options,
      preload: [WORKER_PRELOAD, ...[options?.preload ?? []].flat()],
      ...(options?.env && typeof options.env === "object" ? { env: { ...options.env, ...worker } } : {}),
    })
    globalThis.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, guarded(options) as never)
      }
    } as typeof globalThis.Worker
    threads.Worker = class extends OriginalThreadWorker {
      constructor(file: string | URL, options?: WorkerOptions) {
        super(file, guarded(options) as never)
      }
    }
    syncBuiltinESMExports()
  }

  const handle: Handle = {
    attempts: () => [...input.attempts],
    uninstall: () => {
      globalThis.fetch = originalFetch
      if (OriginalWebSocket) globalThis.WebSocket = OriginalWebSocket
      if (worker) {
        globalThis.Worker = OriginalWorker
        threads.Worker = OriginalThreadWorker
        syncBuiltinESMExports()
      }
      if (sockets && originalBunConnect) sockets.connect = originalBunConnect
      socket.connect = originalConnect
      for (const [key, descriptor] of Object.entries(own)) {
        if (descriptor) Object.defineProperty(request, key, descriptor)
        else delete request[key]
      }
      input.stop?.()
      state.handle = undefined
    },
  }
  state.handle = handle
  return handle
}

function guardedWebSocket(Original: typeof globalThis.WebSocket, input: Wrap) {
  return class extends Original {
    constructor(url: string | URL, protocols?: unknown) {
      // An address WebSocket cannot parse fails in its own constructor, with its own error.
      if (input.active() && URL.canParse(String(url))) {
        const target = new URL(String(url))
        const judged = input.judge({
          kind: "websocket",
          host: target.hostname,
          port: portOf(target),
          url: target.origin,
        })
        if (judged.blocked) throw judged.blocked
        // Bun's WebSocket takes a `proxy` of its own in its options; the proxy environment it does not read.
        const proxy = proxyOption(protocols)
        const blocked = proxy === undefined ? undefined : input.proxied(target, { proxy })
        if (blocked) throw blocked
      }
      super(url, protocols as never)
    }
  } as typeof globalThis.WebSocket
}

function keep(attempts: Attempt[], attempt: Attempt, judged: Judged): Judged {
  attempts.push(attempt)
  if (attempts.length > MAX_ATTEMPTS) attempts.splice(0, attempts.length - MAX_ATTEMPTS)
  return judged
}

// A refused socket either throws where it is made (strict mode) or fails on the next tick with an `error` event.
function refuse(socket: net.Socket, blocked: EgressBlocked, throws: boolean) {
  if (throws) throw blocked
  process.nextTick(() => socket.destroy(blocked))
  return socket
}

// An unlabelled connection under the policy: decided as purpose `unknown` on its URL, or for a raw socket on its host
// and port, which is on the list when an endpoint of either scheme names that host and port.
function socketVerdict(policy: LocalMode.Policy, attempt: Omit<Attempt, "allowed">) {
  const name = attempt.host.includes(":") && !attempt.host.startsWith("[") ? `[${attempt.host}]` : attempt.host
  const port = attempt.port === undefined ? "" : `:${attempt.port}`
  const candidates = attempt.url
    ? [attempt.url.replace(/^ws(s?):/, "http$1:")]
    : [`http://${name}${port}`, `https://${name}${port}`]
  const verdicts = candidates
    .filter((item) => URL.canParse(item))
    .map((url) => LocalPolicy.decide(policy, { purpose: "unknown", url, source: "unlabelled" }))
  return (
    verdicts.find((item) => item.decision === "allow") ??
    verdicts[0] ??
    LocalPolicy.decide(policy, { purpose: "unknown", url: "about:blank", source: "unlabelled" })
  )
}

function configuredProxy(host: string, port: number | undefined) {
  return [...PROXY_VARIABLES]
    .map((key) => process.env[key])
    .filter((value): value is string => Boolean(value) && URL.canParse(value!))
    .map((value) => new URL(value))
    .some((proxy) => sameHost(proxy.hostname, host) && samePort(portOf(proxy), port))
}

function sameHost(left: string, right: string) {
  const a = LocalPolicy.host(left)
  return a !== undefined && a === LocalPolicy.host(right)
}

function samePort(granted: number | undefined, port: number | undefined) {
  return granted === undefined || port === undefined || granted === port
}

function portOf(url: URL) {
  if (url.port) return Number(url.port)
  return url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80
}

function bare(host: string) {
  return host.replace(/^\[|\]$/g, "")
}

// The first frame of the call that made a blocked connection, outside this guard and the runtime's own modules.
function frame() {
  const lines = (new Error().stack ?? "").split("\n").slice(1)
  return lines
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith("at ") && !OWN_FRAME.test(line) && !/\((?:node:|native)|^at (?:node:|native)/.test(line),
    )
    ?.slice(3)
}

// `{ proxy }` in a WebSocket's options (Bun), as a string or `{ url }`.
function proxyOption(options: unknown) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return undefined
  const proxy = (options as { proxy?: unknown }).proxy
  if (typeof proxy === "string") return proxy
  if (proxy && typeof proxy === "object" && typeof (proxy as { url?: unknown }).url === "string")
    return (proxy as { url: string }).url
  return undefined
}

// The same call with a lookup that refuses an answer outside `place`: on the options object, which `connect(port,
// host)` becomes, or on the normalized `[options, listener]` array net.connect passes, replaced in place so the array
// keeps the marker Node reads.
function checkedLookup(args: unknown[], place: EgressAttribution.Within, refused: () => EgressBlocked): unknown[] {
  const listener = args.find((item) => typeof item === "function")
  const checked = (base: Lookup | undefined): Lookup => {
    const lookup = base ?? (dns.lookup as unknown as Lookup)
    return (hostname, options, callback) => {
      const done = typeof options === "function" ? (options as typeof callback) : callback
      lookup(hostname, typeof options === "function" ? {} : options, (error, address, family) => {
        if (error) return done(error, address, family)
        const found = Array.isArray(address) ? address.map((item) => item.address) : [address]
        if (found.every((item) => inside(item, place))) return done(null, address, family)
        done(refused() as NodeJS.ErrnoException, address, family)
      })
    }
  }
  const first = args[0]
  if (Array.isArray(first)) {
    const options = first[0] as { lookup?: Lookup }
    first[0] = { ...options, lookup: checked(options.lookup) }
    return args
  }
  if (first && typeof first === "object") {
    const options = first as { lookup?: Lookup }
    return [{ ...options, lookup: checked(options.lookup) }, ...(listener ? [listener] : [])]
  }
  return [
    { port: Number(first), host: typeof args[1] === "string" ? args[1] : "localhost", lookup: checked(undefined) },
    ...(listener ? [listener] : []),
  ]
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

// `connect(options, listener)`, `connect(port, host, listener)`, `connect(path, listener)`, or the normalized
// `[options, listener]` array Node and Bun pass from `net.connect`. A Unix socket or a Windows pipe stays local. A
// string is a pipe only when it is not a number, as Node's isPipeName reads it: " 80", "0x50", "80.0", "8e1" and "+80"
// are ports.
function socketDestination(args: readonly unknown[]): { host: string; port?: number } | undefined {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  if (typeof first === "string" && !(Number(first) >= 0)) return undefined
  if (typeof first === "number" || typeof first === "string")
    return { host: typeof args[1] === "string" && args[1] ? args[1] : "localhost", port: Number(first) }
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
