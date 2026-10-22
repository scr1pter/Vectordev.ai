export * as EgressGuard from "./guard"

import dns from "node:dns"
import { existsSync } from "node:fs"
import http from "node:http"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"
import { fileURLToPath } from "node:url"
import workerThreads from "node:worker_threads"
import { Option, Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { InstallationVersion } from "../installation/version"
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
// - Only a request for the internet may go through the proxy environment. One for this computer or your network (a
//   local model's prompt included) goes direct: its host joins NO_PROXY before it is sent (`direct`), in the forms
//   both runtimes match, which fetch reads at each request, and the proxy is never granted to it, so a client that
//   still sends it there (Node's node:http agent reads the environment once) is refused at the socket. Under Bun,
//   whose fetch and node:http reach the proxy natively, a request NO_PROXY would still not send direct, read the way
//   Bun reads it (`carried`), is refused before it is sent.
// - A name allowed because its name says where it is (`localhost`, `nas.local`, `box.tail1.ts.net`) must resolve
//   there: a socket's lookup that answers outside is refused before anything connects, and fetch and Bun.connect
//   look the name up first. A name on the model server list is decided on the list instead, since a company's
//   `gpu.internal` may sit on its own public range; a loopback name must still resolve to loopback.
// - fetch reaches only http, https, file, data and blob addresses; any other scheme (Bun's s3:, whose name is a bucket
//   and not where it connects) is refused while the guard decides connections.
// - Under Bun, a Worker started through the global `Worker` or the `node:worker_threads` module object preloads these
//   wraps (`guard-worker.ts`), which follow the policy of the thread that started it (`follow`): the policy in effect
//   when it starts, then each one `announce` sends. What the worker decides comes back to that thread for its log. A
//   worker entry that decides its own policy (the TUI's engine thread) takes over from them (`unfollow`).
// With Vector Local off, each wrap costs one call and logs nothing; a Worker still preloads the wraps, to follow.
//
// Strict mode, for tests (VECTOR_TEST_EGRESS=strict), refuses any connection off this computer and throws. Under Bun it
// also runs a proxy of its own on 127.0.0.1 and points the proxy environment at it, so Bun.fetch, a fetch captured
// before the guard was installed, node:http and a Worker's fetch are refused too, and it preloads its wraps in Workers
// started through the global `Worker` or the `node:worker_threads` module object. Node needs no such proxy: its fetch,
// node:http and WebSocket all connect through net, which the socket wrap decides. Node has no preload either, so a
// Node worker is guarded when its entry imports `backstop-worker.ts` first, as the brain's reader does. Only a test
// may turn it on: a build of Vector and Electron ignore its variables, and so does a process with Vector Local on,
// whose own guard applies (`testEnvironment`), so whatever starts Vector cannot use them to let a name through or to
// stand in a proxy of its own for the guard's.
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
//   module loaded after install, since Bun does not update named imports of built-in modules. In strict mode its fetch
//   still goes through the strict proxy. A worker entry that imports `backstop-worker.ts` first, as the brain's reader
//   does, is guarded however it was started. Under Node, named imports loaded after install see the wrapped class;
// - with Vector Local on under Node, a worker thread whose entry does not import `backstop-worker.ts` first (Node
//   has no preload), and under Bun a Worker in a build whose worker preload is missing (the CLI's build carries it);
// - under Bun, the lookup of a name a node:http client request uses: that request is decided by its name only;
// - under Bun, the lookup fetch makes itself after the guard checked a name allowed by its name: Bun's fetch cannot be
//   told to connect to the address the guard checked without changing the URL the caller sees, so a resolver that
//   answers differently the second time is not caught there (Node's sockets connect to the address they checked);
// - under Bun, the npm `ws` package: Bun replaces it with its own client, which keeps a WebSocket class of its own and
//   reads no global, so a `ws` socket is never seen here. Its one call site, the OpenAI plugin's
//   `connectResponsesWebSocket` (which ws-pool.ts opens its sockets through), decides each model call itself through
//   Egress before it connects. Under Node, `ws` connects through net and is decided here too.

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
   * Whether to run the guard's own proxy and point the proxy environment at it, under Bun. Off in a Worker, which
   * reaches its parent's proxy through the environment it shares. Under Node there is never one: everything there
   * connects through the socket wrap, and Node binds a server only after `listen` returns.
   */
  readonly proxy?: boolean
  /**
   * The strict guard proxy of the process or thread that started this one, which its proxy environment points at and
   * which therefore counts as this guard's own (`testEnvironment().proxy`).
   */
  readonly parentProxy?: string
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

/**
 * What a Worker reads to install strict mode too: on, the pinned names, and the parent's proxy. Only a test honours
 * them (`testEnvironment`).
 */
export const ENVIRONMENT = {
  strict: "VECTOR_TEST_EGRESS",
  names: "VECTOR_TEST_EGRESS_NAMES",
  proxy: "VECTOR_TEST_EGRESS_PROXY",
} as const

/**
 * How a Worker started under Vector Local follows the policy of the thread that decides it (`follow`): the variable
 * its Worker wrap sets to that policy and that thread's id, and the channel that thread announces each new policy on,
 * which the worker sends what it decides back on.
 */
export const FOLLOW = { environment: "VECTOR_EGRESS_FOLLOW", channel: "vector.egress.follow" } as const

/** The refusal of a request for this computer or your network that the proxy environment would still send to a proxy. */
export const PROXY_ENVIRONMENT =
  "It is on this computer or your network, and the proxy settings would still send it to a proxy, which Vector does not let carry such a request. Add its host to NO_PROXY as its address spells it."

export type TestEnvironment = {
  readonly strict: boolean
  readonly names: readonly string[]
  /** The strict guard proxy of the process or thread that started this one. */
  readonly proxy?: string
}

declare global {
  /** Where the compiled CLI carries the worker preload, which its build names. */
  const VECTOR_EGRESS_WORKER_PATH: string
}

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
const NO_PROXY_VARIABLES = ["NO_PROXY", "no_proxy"]
const WEB_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])
// Schemes fetch reads on this computer itself.
const LOCAL_PROTOCOLS = new Set(["file:", "data:", "blob:"])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
export const MAX_REDIRECTS = 20
const MAX_ATTEMPTS = 2_000
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"]
// From source the preload is the file beside this one; the compiled CLI carries it as an entry point of its own.
const WORKER_PRELOAD =
  typeof VECTOR_EGRESS_WORKER_PATH === "string"
    ? VECTOR_EGRESS_WORKER_PATH
    : fileURLToPath(new URL("./guard-worker.ts", import.meta.url))
// A build of Vector (its version is set when it is built) or Electron, where no test runs.
const BUILT = InstallationVersion !== "local" || process.versions.electron !== undefined
const RESOLVED_OUTSIDE = "Its name says it is on this computer or your network, but it resolved to an address outside."
const PROXY_HOP =
  "It is a proxy, which can pass a request anywhere; only a request for the internet that a part of Vector labelled may use it. A request for this computer or your network goes direct: add its host to NO_PROXY."
// Only this guard's own frames are skipped when the log names the code that made a blocked connection.
const OWN_FRAME = /local-mode[\\/](?:guard|attribution|egress|http-client|forward-proxy)\.[jt]s/

// One guard per process, shared by every copy of this module a bundle loads: the desktop's engine carries its own copy
// of core beside the one its entry point imports first.
const KEY = Symbol.for("vector.egress.guard")
type GuardState = {
  handle?: Handle
  /** `local` decides under this thread's policy, `follow` under the policy of the thread that started this one. */
  mode?: "local" | "follow" | "strict"
  /** The strict guard's own proxy, which a request for this computer may go through. */
  strictProxy?: string
  /** A `local` guard's channel to the Workers that follow it. */
  channel?: BroadcastChannel
  /** The policy a `follow` guard decides under. */
  following?: () => LocalMode.Policy
}
const holder = globalThis as unknown as { [KEY]?: GuardState }
const state: GuardState = (holder[KEY] ??= {})

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
type FollowMessage =
  | { readonly type: "ask"; readonly owner: number }
  | { readonly type: "policy"; readonly owner: number; readonly policy: LocalMode.Policy }
  | { readonly type: "recorded"; readonly owner: number; readonly recorded: Recorded }
const Followed = Schema.Struct({ owner: Schema.Number, policy: LocalMode.Policy })

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

/**
 * Where a destination's name must resolve before it is reached: `within` for a name allowed by its name alone. For
 * an origin on the model server list only a loopback name keeps its check; the list decides the rest.
 */
function checkedPlace(host: string, listed: boolean) {
  const place = within(host)
  return listed && place !== "loopback" ? undefined : place
}

/** Whether a resolved address is where `within` says its name must be. */
export function inside(address: string, place: EgressAttribution.Within) {
  const found = LocalPolicy.hostClass(address)
  if (place === "loopback") return found === "this-computer"
  if (found === "this-computer" || found === "your-network") return true
  const octets = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address)
  return place === "tailnet" && Number(octets?.[1]) === 100 && Number(octets?.[2]) >= 64 && Number(octets?.[2]) <= 127
}

/**
 * The hosts and ports a request to `url` connects to: its own, and any proxy that would carry it. The proxy
 * environment carries only a request for the internet; one for this computer or your network goes direct (`direct`).
 * A `proxy` the caller gives is its own choice. For an origin on the model server list (`listed`), where its name
 * resolves is not checked, except that a loopback name must stay on loopback.
 */
export function destinations(
  url: URL,
  options: { readonly proxy?: FetchInit["proxy"]; readonly listed?: boolean } = {},
): EgressAttribution.Grant[] {
  const given = typeof options.proxy === "string" ? options.proxy : options.proxy?.url
  const internet = LocalPolicy.hostClass(url.hostname) === "internet"
  const proxies = (given ? [given] : internet ? environmentProxies(url) : [])
    .filter((item) => URL.canParse(item))
    .map((item) => new URL(item))
  return [
    { host: url.hostname, port: portOf(url), within: checkedPlace(url.hostname, options.listed === true) },
    ...proxies.map((item) => ({ host: item.hostname, port: portOf(item) })),
  ]
}

/**
 * Sends requests for `host` around the proxy environment when it is on this computer or your network: the host joins
 * NO_PROXY and no_proxy (one list, the union of both, so a client that prefers either spelling keeps every entry), in
 * every form a client matches, unless both lists already hold each of them. An entry that only covers it by a pattern
 * (`*.corp`, a bare `::1`) does not count, since Bun honours neither. Bun and Node read them at each fetch, so a
 * corporate proxy never sees a local model's prompt. Only the strict guard's own proxy, in the thread that runs it, is
 * left to decide what it carries.
 */
export function direct(host: string) {
  const name = LocalPolicy.host(host)
  if (!name || LocalPolicy.hostClass(name) === "internet") return
  if (!PROXY_VARIABLES.some((key) => process.env[key] && process.env[key] !== state.strictProxy)) return
  const wanted = noProxyEntries(host)
  const lists = NO_PROXY_VARIABLES.map((key) => noProxyList(process.env[key]))
  if (lists.every((list) => wanted.every((entry) => list.some((item) => item.toLowerCase() === entry)))) return
  const joined = [...new Set([...lists.flat(), ...wanted])].join(",")
  NO_PROXY_VARIABLES.forEach((key) => {
    process.env[key] = joined
  })
}

/**
 * The proxy that the proxy environment would still send a request for `url` through, read the way Bun's fetch and
 * node:http read it: entries split on commas, `*` on its own, a name with the names under it (a leading dot is
 * dropped), an optional port, and an IPv6 address only in brackets. Bun prefers `no_proxy` and falls back to
 * `NO_PROXY`, so here both must send it direct. The strict guard's own proxy does not count. Undefined when it goes
 * direct.
 */
export function carried(url: URL, env: Readonly<Record<string, string | undefined>> = process.env) {
  const secure = url.protocol === "https:" || url.protocol === "wss:"
  const proxy = [
    ...(secure ? [env.HTTPS_PROXY, env.https_proxy] : [env.HTTP_PROXY, env.http_proxy]),
    env.ALL_PROXY,
    env.all_proxy,
  ].find((value) => value && value !== state.strictProxy)
  if (!proxy) return undefined
  const host = url.hostname.toLowerCase()
  const port = url.port || (secure ? "443" : "80")
  const direct = NO_PROXY_VARIABLES.every((key) =>
    noProxyList(env[key]).some((entry) => {
      if (entry === "*") return true
      const parsed = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(entry.toLowerCase())
      if (!parsed?.[1] || (parsed[2] !== undefined && parsed[2] !== port)) return false
      if (parsed[1].startsWith("[")) return parsed[1] === host
      const name = parsed[1].replace(/^\./, "")
      return name !== "" && (host === name || host.endsWith(`.${name}`))
    }),
  )
  return direct ? undefined : proxy
}

/**
 * Sends a request for this computer or your network direct (`direct`), and under Bun, whose fetch and node:http reach
 * the proxy themselves, says which proxy would still carry it (`carried`). A request with a proxy of its own, and one
 * for the internet, are left as they are.
 */
export function around(url: URL, proxy?: FetchInit["proxy"]) {
  direct(url.hostname)
  if (!process.versions.bun || proxy || LocalPolicy.hostClass(url.hostname) === "internet") return undefined
  return carried(url)
}

/** How a request `around` would leave to a proxy is refused and logged. */
export function carriedVerdict(host: string): LocalPolicy.Verdict {
  return {
    decision: "block",
    rule: "proxy-environment",
    class: LocalPolicy.hostClass(host),
    reason: PROXY_ENVIRONMENT,
    allowable: false,
  }
}

/**
 * The test variables (ENVIRONMENT) this process honours. A build of Vector and Electron honour none: no test runs
 * there, and whatever starts Vector (the agent running a nested `vector` included) could set them. Nor does a process
 * with Vector Local on (`local`), whose own guard applies: strict mode's names would let hosts through, and a proxy it
 * took for its own would carry local requests.
 */
export function testEnvironment(
  input: {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly local?: boolean
    readonly built?: boolean
  } = {},
): TestEnvironment {
  const env = input.env ?? process.env
  const off = { strict: false, names: [] }
  if ((input.built ?? BUILT) || env[ENVIRONMENT.strict] !== "strict") return off
  if (input.local ?? LocalPolicy.resolve({ env }).enabled) return off
  return {
    strict: true,
    names: (env[ENVIRONMENT.names] ?? "").split(",").filter(Boolean),
    proxy: env[ENVIRONMENT.proxy] || undefined,
  }
}

export function installed() {
  return state.handle !== undefined
}

/**
 * Installs the backstop: every connection is decided under the policy `options.policy` returns at that moment. A
 * refused fetch or Bun.connect rejects with EgressBlocked; a refused socket or node:http request fails with it as its
 * `error` event, the way a refused connection does; a refused WebSocket throws. Under Bun, the Workers this thread
 * starts follow that policy (`follow`), and what they decide comes to `options.record` too.
 */
export function install(options: Options): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const owner = workerThreads.threadId
  const channel = process.versions.bun ? new BroadcastChannel(FOLLOW.channel) : undefined
  if (channel) {
    // A worker that has just started asks for the policy in case one was announced before it listened.
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as FollowMessage | undefined
      if (message?.owner !== owner) return
      if (message.type === "ask") channel.postMessage({ type: "policy", owner, policy: options.policy() })
      if (message.type === "recorded") options.record?.(message.recorded)
    }
    unref(channel)
  }
  const handle = decider(options, { owner, stop: () => channel?.close() })
  state.mode = "local"
  state.channel = channel
  return handle
}

/**
 * Installs the backstop in a Worker the guard saw started, under Bun (the worker preload): connections are decided
 * under the policy of the thread that decides it, which the Worker wrap passed in FOLLOW.environment, and then each
 * one it announces. What the worker decides goes back to that thread for its log. A worker started without the
 * variable (one that shares its parent's environment) follows the main thread, with only this computer reachable
 * until it answers.
 */
export function follow(env: Record<string, string | undefined> = process.env): Handle {
  if (state.handle) throw new Error("The egress guard is already installed.")
  const text = env[FOLLOW.environment]
  // The programs the worker starts are not Workers it follows for.
  delete env[FOLLOW.environment]
  const followed = Option.getOrElse(
    text ? Schema.decodeUnknownOption(Schema.fromJsonString(Followed))(text) : Option.none(),
    () => ({ owner: 0, policy: LocalPolicy.PENDING }),
  )
  const current = { policy: followed.policy }
  const channel = new BroadcastChannel(FOLLOW.channel)
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as FollowMessage | undefined
    if (message?.type === "policy" && message.owner === followed.owner) current.policy = message.policy
  }
  unref(channel)
  channel.postMessage({ type: "ask", owner: followed.owner } satisfies FollowMessage)
  const handle = decider(
    {
      policy: () => current.policy,
      record: (recorded) =>
        channel.postMessage({ type: "recorded", owner: followed.owner, recorded } satisfies FollowMessage),
    },
    { owner: followed.owner, stop: () => channel.close() },
  )
  state.mode = "follow"
  state.following = () => current.policy
  return handle
}

/** The policy this thread's guard follows when the worker preload installed it (`follow`). */
export function followed() {
  return state.mode === "follow" ? state.following?.() : undefined
}

/** Removes a guard the worker preload installed to follow (`follow`), so the worker's entry can install its own. */
export function unfollow() {
  if (state.mode === "follow") state.handle?.uninstall()
}

/** Tells the Workers that follow this thread's guard (`follow`) the policy now in effect. */
export function announce(policy: LocalMode.Policy) {
  if (state.mode !== "local") return
  state.channel?.postMessage({ type: "policy", owner: workerThreads.threadId, policy } satisfies FollowMessage)
}

// The guard under a policy: Vector Local's, read at every connection.
function decider(options: Options, owned: { readonly owner: number; readonly stop: () => void }): Handle {
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
    return keep(attempts, outcome, { within: checkedPlace(attempt.host, verdict.class === "listed") })
  }
  // A refusal the guard makes after the request was allowed, logged with the label of the request that made it.
  const refused = (attempt: Omit<Attempt, "allowed">, verdict: LocalPolicy.Verdict) => {
    options.record?.({
      attempt: { ...attempt, allowed: false },
      verdict,
      scope: EgressAttribution.current(),
      frame: frame(),
    })
    return new EgressBlocked(attempt.host, attempt.kind, verdict.rule, verdict.reason)
  }
  // A name that resolved outside where it said it was is logged as its own refusal.
  const outside = (attempt: Omit<Attempt, "allowed">) =>
    refused(attempt, {
      decision: "block",
      rule: "resolved-outside",
      class: LocalPolicy.hostClass(attempt.host),
      reason: RESOLVED_OUTSIDE,
      allowable: false,
    })
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
  // A worker preload a build left out would stop every Worker from starting, so a Worker then starts as it is.
  const preload = process.versions.bun !== undefined && existsSync(WORKER_PRELOAD)
  return wrap({
    active: () => options.policy().enabled,
    judge,
    socketJudge,
    proxied,
    outside,
    carried: (attempt) => refused(attempt, carriedVerdict(attempt.host)),
    throws: false,
    attempts,
    ...(preload && {
      worker: () => ({
        [FOLLOW.environment]: JSON.stringify({ owner: owned.owner, policy: options.policy() }),
      }),
    }),
    stop: owned.stop,
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
    options.proxy === false || !process.versions.bun
      ? undefined
      : ForwardProxy.startSync((destination) => {
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
  const ownProxy = proxy?.url ?? options.parentProxy
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
    carried: (attempt) => new EgressBlocked(attempt.host, attempt.kind, "proxy-environment", PROXY_ENVIRONMENT),
    throws: options.throws !== false,
    attempts,
    worker: () => strictEnvironment,
    stop: () => {
      proxy?.stop()
      // Bun's fetch reads the proxy environment at each request, and deleting a variable does not reach it, so a
      // variable that was unset is emptied first. NO_PROXY stays, empty: Bun never sees a variable set again once it
      // was deleted, and `direct` may need it later.
      if (ownProxy)
        saved.forEach(([key, value]) => {
          process.env[key] = value ?? ""
          if (value === undefined && !NO_PROXY_VARIABLES.includes(key)) delete process.env[key]
        })
    },
  })
  state.mode = "strict"
  state.strictProxy = ownProxy
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
  /** The refusal of an allowed request for this computer or your network that a proxy would still carry (`around`). */
  readonly carried: (attempt: Omit<Attempt, "allowed">) => EgressBlocked
  readonly throws: boolean
  readonly attempts: Attempt[]
  /** The environment every Worker this guard sees started gets, with the guard preloaded; none when it has no preload. */
  readonly worker?: () => Readonly<Record<string, string>>
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
  // or the proxy that carries it, passes as this request. A request for this computer or your network goes direct.
  const send = (
    target: URL,
    init: FetchInit | undefined,
    checked: { readonly attempt: Omit<Attempt, "allowed">; readonly judged: Judged },
    run: () => Promise<Response>,
  ) => {
    if (around(target, init?.proxy)) return Promise.reject(input.carried(checked.attempt))
    const judged = checked.judged
    const scope = EgressAttribution.current()
    const [own, ...proxies] = destinations(target, { proxy: init?.proxy })
    return EgressAttribution.granted(
      {
        source: scope?.source ?? "unlabelled",
        purpose: scope?.purpose ?? "unknown",
        grants: [...(scope?.grants ?? []), { ...own!, within: judged.within }, ...proxies],
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
    return follow(
      await send(next, following, checked, () => originalFetch(next, following)),
      next,
      following,
      count + 1,
    )
  }
  const fetch = ((target: Parameters<Fetch>[0], init?: FetchInit) => {
    if (!input.active()) return originalFetch(target, init)
    const address = target instanceof Request ? target.url : String(target)
    // A Unix socket, a data: or blob: URL and an address fetch cannot parse never leave the computer through here.
    if (init?.unix || !URL.canParse(address)) return originalFetch(target, init)
    const url = new URL(address)
    if (LOCAL_PROTOCOLS.has(url.protocol)) return originalFetch(target, init)
    // Any other scheme fetch reaches itself is decided as an address with no http or https host, which is refused.
    if (!WEB_PROTOCOLS.has(url.protocol))
      return Promise.reject(
        input.judge({ kind: "fetch", host: `${url.protocol}//${url.host}`, url: `${url.protocol}//${url.host}` })
          .blocked ?? new EgressBlocked(url.protocol, "fetch"),
      )
    const first = firstHop(target, init)
    const checked = decide(url, init, first.method)
    if (checked.blocked) return Promise.reject(checked.blocked)
    const mode = init?.redirect ?? (target instanceof Request ? target.redirect : "follow")
    return resolved(checked.attempt, checked.judged.within).then((outside) => {
      if (outside) throw outside
      if (mode !== "follow") return send(url, init, checked, () => originalFetch(target, init))
      return send(url, init, checked, () => originalFetch(target, { ...init, redirect: "manual" })).then((response) =>
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
  methods.forEach((key) => {
    const original = request[key] as (...input: unknown[]) => unknown
    request[key] = function (this: http.ClientRequest & { socketPath?: string; port?: unknown }, ...args: unknown[]) {
      if (!input.active() || decided.has(this) || this.socketPath) return original.apply(this, args)
      decided.add(this)
      const host = String(this.host ?? "localhost")
      const attempt = { kind: "http" as const, host, port: numberOf(this.port), method: this.method }
      const judged = input.judge(attempt)
      // Bun's client reads the proxy environment the way its fetch does.
      const name = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
      const address = `${this.protocol || "http:"}//${name}${attempt.port === undefined ? "" : `:${attempt.port}`}`
      const target = URL.canParse(address) ? new URL(address) : undefined
      if (!target && !judged.blocked) direct(host)
      const blocked = judged.blocked ?? (target && around(target) ? input.carried(attempt) : undefined)
      if (!blocked) return original.apply(this, args)
      if (input.throws) throw blocked
      // Bun's request emits nothing when it is destroyed before it starts, so the refusal is its error event.
      process.nextTick(() => {
        this.emit("error", blocked)
        this.destroy()
      })
      return key === "write" ? false : this
    }
  })

  // These same wraps are preloaded in every Worker this guard sees started (Bun's `preload`; Node ignores it, and its
  // workers get the environment): strict mode's with the names and the proxy they read from it, Vector Local's
  // following this thread's policy. Node has no global Worker, only node:worker_threads' one, so only the classes this
  // runtime has are wrapped.
  const threads = workerThreads as unknown as { Worker?: typeof workerThreads.Worker }
  const OriginalWorker = globalThis.Worker as typeof globalThis.Worker | undefined
  const OriginalThreadWorker = threads.Worker
  const worker = input.worker
  if (worker) {
    // A worker starts with a copy of the environment it is given, or of this thread's; one that shares this thread's
    // (SHARE_ENV) reads what is set here.
    const guarded = (options: WorkerOptions | undefined) => ({
      ...options,
      preload: [WORKER_PRELOAD, ...[options?.preload ?? []].flat()],
      ...(options?.env === undefined || (options.env && typeof options.env === "object")
        ? { env: { ...((options?.env as Record<string, string> | undefined) ?? process.env), ...worker() } }
        : {}),
    })
    if (OriginalWorker)
      globalThis.Worker = class extends OriginalWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, guarded(options) as never)
        }
      } as typeof globalThis.Worker
    if (OriginalThreadWorker)
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
      if (worker && OriginalWorker) globalThis.Worker = OriginalWorker
      if (worker && OriginalThreadWorker) threads.Worker = OriginalThreadWorker
      if (worker) syncBuiltinESMExports()
      if (sockets && originalBunConnect) sockets.connect = originalBunConnect
      socket.connect = originalConnect
      // A method Bun's prototype did not have of its own goes back to the one it inherits.
      Object.entries(own).forEach(([key, descriptor]) =>
        descriptor ? Object.defineProperty(request, key, descriptor) : delete request[key],
      )
      input.stop?.()
      state.handle = undefined
      state.mode = undefined
      state.strictProxy = undefined
      state.channel = undefined
      state.following = undefined
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
        // Bun's WebSocket takes a `proxy` of its own in its options; the proxy environment it does not read. Node's
        // reads it once its global proxy is set, so a WebSocket to this computer or your network goes direct.
        const proxy = proxyOption(protocols)
        const blocked = proxy === undefined ? undefined : input.proxied(target, { proxy })
        if (blocked) throw blocked
        direct(target.hostname)
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

// One NO_PROXY variable's entries, as every client splits them: on commas, each trimmed.
function noProxyList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

// The NO_PROXY entries that send a request for `host` direct in every client: the host as its address spells it, which
// Bun matches, and as a resolver reads it (no trailing dot, IPv4 written out); an IPv6 address both in brackets, the
// only form Bun matches, and bare, the form Node matches.
function noProxyEntries(host: string) {
  const spelled = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
  return [...new Set([spelled, LocalPolicy.host(host) ?? spelled])].flatMap((item) =>
    item.includes(":") ? [`[${item}]`, item] : [item],
  )
}

// A channel the guard keeps open never keeps a process or a worker running by itself.
function unref(channel: BroadcastChannel) {
  ;(channel as unknown as { unref?: () => void }).unref?.()
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
