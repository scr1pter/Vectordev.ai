export * as Egress from "./egress"

import { randomUUID } from "node:crypto"
import { isMainThread, threadId } from "node:worker_threads"
import { Context, Effect, Layer } from "effect"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import { makeGlobalNode } from "../effect/app-node"
import { isHelperName } from "../session/helper"
import { EgressAttribution } from "./attribution"
import { EgressGuard } from "./guard"
import { EgressLogStore } from "./log-store"
import { LocalPolicy } from "./policy"
import { LocalSources } from "./sources"
import { LocalStartup } from "./startup"

// Vector Local's egress service: the one place a labelled request is decided, logged and sent. It is process-global
// and takes no session ID; who a request is for travels in EgressAttribution's scope. Every source in the registry has
// one call site that asks `decide` or sends through `fetch` (or EgressHttpClient, which sends through `fetch`), and the
// backstop guard (`backstop()`) decides whatever else connects.
//
// The policy starts as Vector Local off: everything passes and nothing is logged. When anything Vector Local reads at
// start may turn it on (the environment, VECTOR_LOCAL=1, which Vector's children inherit, or a managed or user config
// file: LocalStartup), `backstop` starts it pending instead, before any other module runs: only this computer is
// reachable, for every purpose, until config sets the policy it resolves at start with `resolve` or `configure`. The
// engine's config resolves it synchronously when its module loads, before any layer or startup fetch, and hands each
// later one here as it takes effect (engine config.ts, refreshLocal); the desktop's main process resolves its own from
// the desktop's folders with LocalStartup.policy. From then on every decision reads it. While Vector Local is on, each
// decision is an event: in memory (the last 2,000), on disk when a log directory is configured, and in the counters
// the pane shows.
//
// Each thread of a process holds its own copy of this state (the TUI's engine thread, a Worker the guard preloaded),
// so the threads keep one between them over a BroadcastChannel, which never leaves the process: the policy set last
// reaches every thread, a Worker starts with the one in effect, and every event reaches every thread's memory and
// counters. Only the thread that configured the log last writes it to disk.

export type Request = {
  /** The registry source making the request (LocalSources). An id the registry does not have is purpose `unknown`. */
  readonly source: string
  readonly url: string | URL
  readonly method?: string
  /** A check the user started themselves, such as Check for updates. */
  readonly manual?: boolean
  readonly tool?: string
  /** A block the user caused, which the app tells them about (coalesced) rather than only listing it. */
  readonly notify?: boolean
  /** The size of the request's body, when it is known before it is sent. */
  readonly bytes?: number
}

export type Decided = LocalPolicy.Verdict & {
  readonly purpose: LocalMode.Purpose
  /** The log line, while Vector Local is on. */
  readonly event?: LocalMode.Event
}

export type FetchInit = RequestInit & {
  readonly manual?: boolean
  readonly tool?: string
  /** A proxy of the caller's own (Bun's fetch option); it is granted to this request only. */
  readonly proxy?: string | { readonly url: string }
}

export type Filter = {
  readonly since?: number
  readonly session?: string
  readonly blocked?: boolean
}

export type LogOptions = { readonly directory: string; readonly retainDays?: number }

/** The fetch a labelled request's hops go through. */
export type Send = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Unlabelled blocks and the blocks a user caused are told once per source in this window. */
export const NOTICE_WINDOW = 10 * 60 * 1000

const ZERO: LocalMode.Carried = { personal: 0, documents: 0, repository: 0 }
const WEB = new Set<LocalMode.Purpose>(["web-page", "browser", "research-reader", "research-browser"])

type Totals = {
  requests: number
  helper_requests: number
  model_calls: Record<string, number>
  pages: number
  hosts: Set<string>
  searches: number
  carried: { personal: number; documents: number; repository: number }
  blocked: Record<string, number>
}

// Which policy is the latest across the threads of a process: a count each `configure` raises past the highest it has
// seen, then the thread's id, so two threads that set one at once agree on which wins.
type Version = readonly [count: number, thread: number]

// What the threads of a process tell each other (see the comment at the top). `log` says the sender now writes the
// log, so a thread that wrote it stops.
type Message =
  | { readonly kind: "policy"; readonly policy: LocalMode.Policy; readonly version: Version; readonly log: boolean }
  | { readonly kind: "ask" }
  | {
      readonly kind: "event"
      readonly event: LocalMode.Event
      readonly notify: boolean
      readonly agent: string | undefined
    }
  | { readonly kind: "erase" }

type State = {
  policy: LocalMode.Policy
  version: Version
  /** Whether this thread's policy was set by config or by another thread, rather than assumed at start. */
  known: boolean
  channel?: BroadcastChannel
  ring: EgressLogStore.Ring
  log?: LogOptions
  store?: EgressLogStore.Store
  /** The writes of a store that was let go, which reads and Erase wait for. */
  writing: Promise<void>
  listeners: Set<(event: LocalMode.Event) => void>
  noticeListeners: Set<(event: LocalMode.Event) => void>
  noticed: Map<string, number>
  /** One-time grants left by source; Infinity for a grant that lasts while this process runs. */
  grants: Map<string, number>
  totals: Map<string, Totals>
}

// One state per thread, shared by every copy of this module a bundle or a test loads, as the guard reads it.
const KEY = Symbol.for("vector.egress.state")
const CHANNEL = "vector.egress"
const holder = globalThis as unknown as { [KEY]?: State }
const state: State = (holder[KEY] ??= {
  policy: LocalPolicy.OFF,
  version: [0, threadId],
  known: false,
  ring: EgressLogStore.ring(),
  writing: Promise.resolve(),
  listeners: new Set(),
  noticeListeners: new Set(),
  noticed: new Map(),
  grants: new Map(),
  totals: new Map(),
})

export function policy() {
  return state.policy
}

/**
 * Holds every request but those to this computer, in every thread of this process, until config sets the policy it
 * resolves. The backstop starts a thread pending itself when the environment turns Vector Local on.
 */
export function pending() {
  return configure(LocalPolicy.PENDING)
}

/**
 * Sets the policy in effect, for every thread of this process, and returns it. With a log directory, the log is
 * written there while Vector Local is on; turning Vector Local off stops writing it and keeps what was written until
 * it is erased. A log directory Vector cannot use (a file in its place, a folder another user owns, a read-only disk)
 * changes nothing else: the policy applies, every event stays in memory, the returned policy's warnings say so, and
 * each later call tries again.
 */
export function configure(next: LocalMode.Policy, options: { readonly log?: LogOptions } = {}) {
  const applied = apply(next, options)
  state.version = [state.version[0] + 1, threadId]
  state.known = true
  post({ kind: "policy", policy: applied, version: state.version, log: options.log !== undefined })
  return applied
}

function apply(next: LocalMode.Policy, options: { readonly log?: LogOptions }) {
  if (options.log || !next.enabled) release()
  if (options.log) state.log = options.log
  const opened = next.enabled && state.log && !state.store ? openLog(state.log) : undefined
  if (typeof opened === "object") state.store = opened
  state.policy = typeof opened === "string" ? { ...next, warnings: [...next.warnings, opened] } : next
  return state.policy
}

// Stops writing the log here; what was written stays until it is erased.
function release() {
  if (!state.store) return
  state.writing = Promise.all([state.writing, state.store.flush()]).then(() => undefined)
  state.store = undefined
}

/**
 * Joins this thread to the others of its process (see the comment at the top), once, and asks for the policy in
 * effect. The channel never keeps a thread alive.
 */
function join() {
  if (state.channel) return
  const channel = new BroadcastChannel(CHANNEL)
  ;(channel as { unref?: () => void }).unref?.()
  channel.onmessage = (event: MessageEvent<Message>) => receive(event.data)
  state.channel = channel
  post({ kind: "ask" })
}

function post(message: Message) {
  state.channel?.postMessage(message)
}

function receive(message: Message) {
  // The main thread always answers, so a worker that started without a policy of its own (one that shares this
  // thread's environment) stops holding everything once it hears.
  if (message.kind === "ask") {
    if (state.known || isMainThread) post({ kind: "policy", policy: state.policy, version: state.version, log: false })
    return
  }
  if (message.kind === "event") return remember(message.event, message.notify, message.agent)
  if (message.kind === "erase") {
    state.ring.clear()
    state.totals.clear()
    state.noticed.clear()
    void state.writing.then(() => state.store?.clear())
    return
  }
  const [count, thread] = message.version
  if (count < state.version[0] || (count === state.version[0] && thread <= state.version[1])) return
  state.version = message.version
  state.known = true
  // Another thread writes the log now.
  if (message.log) {
    release()
    state.log = undefined
  }
  apply(message.policy, {})
}

/**
 * Resolves the policy from its sources and sets it. The cloud AI hosts a user may not list as a model server are the
 * registry's plus every provider address in `catalog`, the model catalog Vector has.
 */
export function resolve(
  sources: LocalPolicy.Sources & { readonly catalog?: Parameters<typeof LocalSources.cloudHosts>[0] },
  options: { readonly log?: LogOptions } = {},
) {
  const { catalog, ...rest } = sources
  return configure(
    LocalPolicy.resolve({
      ...rest,
      cloudHosts: rest.cloudHosts ?? (catalog ? LocalSources.cloudHosts(catalog) : undefined),
    }),
    options,
  )
}

/** Whether a labelled request may go, and its log line while Vector Local is on. */
export function decide(request: Request): Decided {
  const purpose = LocalSources.get(request.source)?.purpose ?? "unknown"
  const verdict = LocalPolicy.decide(state.policy, {
    purpose,
    url: request.url,
    source: request.source,
    manual: request.manual,
  })
  // A one-time grant answers one ask: a download, or a manual update check the user confirmed.
  const final =
    verdict.decision === "ask" && take(request.source)
      ? { ...verdict, decision: "allow" as const, reason: "You allowed this once." }
      : verdict
  return { ...final, purpose, event: record(request, final) }
}

/**
 * Logs a decision a labelled call site made with a rule of its own, such as the research browsers' proxy refusing a
 * private address, while Vector Local is on.
 */
export function record(request: Request, verdict: LocalPolicy.Verdict) {
  if (!state.policy.enabled) return undefined
  return push(
    {
      source: request.source,
      purpose: LocalSources.get(request.source)?.purpose ?? "unknown",
      origin: originOf(request.url),
      method: request.method ?? "GET",
      verdict,
      tool: request.tool,
      bytes: request.bytes,
    },
    request.notify,
  )
}

/** Lets the next ask from `source` through once, or every one while this process runs. */
export function grant(source: string, options: { readonly once: boolean } = { once: true }) {
  const left = state.grants.get(source) ?? 0
  state.grants.set(source, options.once ? left + 1 : Number.POSITIVE_INFINITY)
}

/**
 * Sends one labelled request: every hop is decided and logged before it is made, the way `decide` does, and runs with
 * only that hop's destinations granted. A model call (purpose inference) never follows a redirect. A blocked hop, or
 * one that would need the user's answer, rejects with EgressBlocked; the user's answer comes back as `grant` or
 * `manual`. `send` is the fetch each hop goes through: the global one unless the caller has its own, such as a fetch
 * pinned to the addresses it checked.
 */
export async function fetch(
  source: string,
  input: RequestInfo | URL,
  init: FetchInit = {},
  send: Send = (target, options) => globalThis.fetch(target, options),
): Promise<Response> {
  const { manual, tool, ...options } = init
  if (!state.policy.enabled) return send(input, options)
  const inference = (LocalSources.get(source)?.purpose ?? "unknown") === "inference"
  const mode = inference ? "error" : (options.redirect ?? (input instanceof Request ? input.redirect : "follow"))
  const first = mode === "follow" ? await EgressGuard.followedHop(input, options) : EgressGuard.firstHop(input, options)
  const hop = async (url: URL, current: EgressGuard.Hop, count: number): Promise<Response> => {
    const request = { source, url, method: current.method, manual, tool, bytes: bodySize(current.body) }
    // A request for this computer or your network, such as a local model's prompt, never goes through a proxy: it
    // goes direct, or, under Bun, is refused when the proxy environment would still carry it.
    EgressGuard.direct(url.hostname)
    if (EgressGuard.carried(url, options.proxy)) {
      const refused = proxyRefusal(url)
      record(request, refused)
      throw new EgressGuard.EgressBlocked(url.hostname, "fetch", refused.rule, refused.reason)
    }
    const decided = decide(request)
    if (decided.decision !== "allow")
      throw new EgressGuard.EgressBlocked(url.hostname, "fetch", decided.rule, decided.reason)
    const grants = EgressGuard.destinations(url, {
      proxy: options.proxy,
      exempt: decided.class === "listed" && LocalPolicy.exempt(state.policy, url),
    })
    const response = await EgressAttribution.granted({ source, purpose: decided.purpose, grants }, () =>
      send(count === 0 ? input : url, count === 0 ? { ...options, redirect: "manual" } : current),
    )
    const next = mode === "manual" ? undefined : EgressGuard.redirectTarget(response, url)
    if (!next) {
      if (count > 0) Object.defineProperty(response, "redirected", { value: true })
      return response
    }
    await response.body?.cancel()
    if (mode === "error")
      throw new TypeError(
        inference
          ? `${url.origin} answered a model call with a redirect, which Vector does not follow.`
          : `${url.origin} answered with a redirect, and this request follows none.`,
      )
    if (count >= EgressGuard.MAX_REDIRECTS)
      throw new TypeError(`Too many redirects: more than ${EgressGuard.MAX_REDIRECTS}.`)
    return hop(next, EgressGuard.redirectHop(current, response.status, url, next), count + 1)
  }
  return hop(new URL(input instanceof Request ? input.url : String(input)), first, 0)
}

/** The events in memory, oldest first. */
export function events(filter: Filter = {}) {
  return state.ring
    .list()
    .filter(
      (event) =>
        (filter.since === undefined || event.time >= filter.since) &&
        (filter.session === undefined ||
          event.session_id === filter.session ||
          event.root_session_id === filter.session) &&
        (filter.blocked === undefined || (event.decision !== "allow") === filter.blocked),
    )
}

/** Every event on disk, for Export; the events in memory when no log directory is configured. */
export async function exported(filter: Filter = {}) {
  await state.writing
  const opened = state.store ?? (state.log ? openLog(state.log) : undefined)
  const store = typeof opened === "string" ? undefined : opened
  if (!store) return events(filter)
  const all = await store.read({ since: filter.since })
  return all.filter(
    (event) =>
      (filter.session === undefined ||
        event.session_id === filter.session ||
        event.root_session_id === filter.session) &&
      (filter.blocked === undefined || (event.decision !== "allow") === filter.blocked),
  )
}

/** Erases the log: memory, counters and files, in every thread of this process. */
export async function erase() {
  state.ring.clear()
  state.totals.clear()
  state.noticed.clear()
  post({ kind: "erase" })
  await state.writing
  const opened = state.store ?? (state.log ? openLog(state.log) : undefined)
  if (typeof opened === "object") await opened.clear()
}

/** The counters for one root session (helpers roll into the session that launched them), or for the process. */
export function summary(rootID?: string): LocalMode.Summary {
  const totals = state.totals.get(rootID ?? "*")
  if (!totals)
    return {
      requests: 0,
      helper_requests: 0,
      model_calls: {},
      pages: 0,
      hosts: 0,
      searches: 0,
      carried: ZERO,
      blocked: {},
    }
  return {
    requests: totals.requests,
    helper_requests: totals.helper_requests,
    model_calls: { ...totals.model_calls },
    pages: totals.pages,
    hosts: totals.hosts.size,
    searches: totals.searches,
    carried: { ...totals.carried },
    blocked: { ...totals.blocked },
  }
}

/** Every event as it is recorded. Returns the function that stops listening. */
export function subscribe(listener: (event: LocalMode.Event) => void) {
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

/**
 * The blocks the user is told about: requests no call site labelled, and blocks the user caused, at most once per
 * source per NOTICE_WINDOW. Expected blocks are only listed. Returns the function that stops listening.
 */
export function notices(listener: (event: LocalMode.Event) => void) {
  state.noticeListeners.add(listener)
  return () => {
    state.noticeListeners.delete(listener)
  }
}

/** Records an event made elsewhere, such as the desktop's own windows, while Vector Local is on. */
export function report(event: LocalMode.Event) {
  if (!state.policy.enabled) return
  remember(event, false)
  post({ kind: "event", event, notify: false, agent: undefined })
}

/**
 * Installs the backstop guard for this thread with this service's policy and log. Strict mode (tests, in a source
 * checkout only, never with Vector Local on: EgressGuard.strictFromEnvironment) installs the strict guard instead.
 * Nothing happens when a guard is already installed. When anything Vector Local reads at start may turn it on, the
 * policy starts pending until config resolves it. A Worker the guard started (guard-worker.ts) starts with the policy
 * its parent handed it instead, and every thread then keeps the policy the others set; one a sealed thread started is
 * sealed.
 */
export function backstop() {
  if (EgressGuard.installed()) return undefined
  // Only a Worker the guard started reads what it was handed from its environment (EgressGuard.handed); a value
  // inherited from anywhere else is dropped, and neither is passed on to a child process.
  const handed = EgressGuard.handed()
  start(handed && "policy" in handed ? handed.policy : undefined)
  // The test variables mean nothing once Vector Local may be on, from any source it reads at start.
  const strict = EgressGuard.strictFromEnvironment(process.env, undefined, state.policy.enabled)
  if (strict)
    return EgressGuard.installStrict({
      names: strict.names,
      // A worker, or a process a strict parent started, reaches the parent's proxy through the environment.
      proxy: isMainThread && !strict.proxy,
      parentProxy: strict.proxy,
    })
  // A Worker started in a sealed thread (the brain's reader) is sealed too: any connection off this computer fails.
  if (handed && "sealed" in handed) return EgressGuard.installStrict({ proxy: false, throws: false })
  join()
  return EgressGuard.install({ policy, record: recordAttempt })
}

// The policy a thread starts with: the one its parent handed it, which the environment can only tighten, or pending
// when anything Vector Local reads at start may turn it on (LocalStartup).
function start(handed: LocalMode.Policy | undefined) {
  const floor = LocalPolicy.resolve({ env: process.env }).enabled
  if (handed && (handed.enabled || !floor)) {
    state.policy = handed
    state.known = true
    return
  }
  if (!state.policy.enabled && (floor || LocalStartup.enabled())) state.policy = LocalPolicy.PENDING
}

// A connection the guard decided itself. A refusal of a request the guard had allowed (a name that resolved outside
// where it said it was, or one a proxy would still carry) keeps the label of the request that made it; anything else
// is unlabelled.
function recordAttempt(recorded: EgressGuard.Recorded) {
  const labelled =
    recorded.verdict.rule === "resolved-outside" || recorded.verdict.rule === "proxy-environment"
      ? recorded.scope
      : undefined
  const attempt = recorded.attempt
  push({
    source: labelled?.source ?? "unlabelled",
    purpose: labelled?.purpose ?? "unknown",
    origin: attempt.url ?? `${attempt.host.includes(":") ? `[${attempt.host}]` : attempt.host}:${attempt.port ?? ""}`,
    method: attempt.method ?? (attempt.kind === "fetch" || attempt.kind === "http" ? "GET" : "CONNECT"),
    verdict: recorded.verdict,
    frame: recorded.frame,
  })
}

function push(
  input: {
    readonly source: string
    readonly purpose: LocalMode.Purpose
    readonly origin: string
    readonly method: string
    readonly verdict: LocalPolicy.Verdict
    readonly tool?: string
    readonly frame?: string
    readonly bytes?: number
  },
  notify = false,
) {
  const scope = EgressAttribution.current()
  const event: LocalMode.Event = {
    id: randomUUID(),
    time: Date.now(),
    source: input.source,
    purpose: input.purpose,
    class: input.verdict.class,
    origin: input.origin,
    method: input.method.toUpperCase(),
    // What came back is not known when a request is decided, so only what it sends is counted.
    ...(input.bytes !== undefined ? { bytes_out: input.bytes } : {}),
    decision: input.verdict.decision,
    rule: input.verdict.rule,
    reason: input.verdict.reason,
    ...(scope?.sessionID ? { session_id: scope.sessionID } : {}),
    ...(scope?.rootID || scope?.sessionID ? { root_session_id: scope.rootID ?? scope.sessionID } : {}),
    ...(input.tool ? { tool: input.tool } : {}),
    carried: scope?.carried ?? ZERO,
    ...(input.frame ? { frame: input.frame } : {}),
  }
  const told = notify || (event.decision !== "allow" && event.source === "unlabelled")
  remember(event, told, scope?.agent)
  post({ kind: "event", event, notify: told, agent: scope?.agent })
  return event
}

function remember(event: LocalMode.Event, notify: boolean, agent?: string) {
  state.ring.push(event)
  state.store?.append(event)
  new Set(["*", event.root_session_id ?? "*"]).forEach((key) => count(key, event, agent))
  state.listeners.forEach((listener) => listener(event))
  if (!notify || event.decision === "allow") return
  const last = state.noticed.get(event.source)
  if (last !== undefined && event.time - last < NOTICE_WINDOW) return
  state.noticed.set(event.source, event.time)
  state.noticeListeners.forEach((listener) => listener(event))
}

function count(key: string, event: LocalMode.Event, agent: string | undefined) {
  const totals =
    state.totals.get(key) ??
    state.totals
      .set(key, {
        requests: 0,
        helper_requests: 0,
        model_calls: {},
        pages: 0,
        hosts: new Set(),
        searches: 0,
        carried: { ...ZERO },
        blocked: {},
      })
      .get(key)!
  totals.requests += 1
  if (agent && isHelperName(agent)) totals.helper_requests += 1
  if (event.decision !== "allow") {
    totals.blocked[event.source] = (totals.blocked[event.source] ?? 0) + 1
    return
  }
  if (event.purpose === "inference") totals.model_calls[event.origin] = (totals.model_calls[event.origin] ?? 0) + 1
  if (WEB.has(event.purpose)) {
    totals.pages += 1
    totals.hosts.add(event.origin)
  }
  if (event.purpose === "web-search") totals.searches += 1
  totals.carried.personal += event.carried.personal
  totals.carried.documents += event.carried.documents
  totals.carried.repository += event.carried.repository
}

function proxyRefusal(url: URL): LocalPolicy.Verdict {
  return {
    decision: "block",
    rule: "proxy-environment",
    class: LocalPolicy.classify(state.policy, url),
    reason: EgressGuard.PROXY_LOCAL,
    allowable: false,
  }
}

// A body's size in bytes when it is known without reading it: text, bytes, a Blob or form fields.
function bodySize(body: BodyInit | null | undefined) {
  if (typeof body === "string") return Buffer.byteLength(body)
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof Blob) return body.size
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString())
  return undefined
}

// The network log on disk, or why Vector cannot use its folder: opening it makes the folder and sets it to 0700
// synchronously, which throws for a file in its place, a folder another user owns or a read-only disk.
function openLog(log: LogOptions): EgressLogStore.Store | string {
  try {
    return EgressLogStore.open(log)
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` (${error.code})` : ""
    return `Vector could not write its network log in ${log.directory}${code}, so it keeps this session's log in memory only. It tries again the next time it reads its settings.`
  }
}

function take(source: string) {
  const left = state.grants.get(source) ?? 0
  if (left <= 0) return false
  state.grants.set(source, left - 1)
  return true
}

function originOf(input: string | URL) {
  const text = String(input)
  if (!URL.canParse(text)) return "unknown"
  const url = new URL(text)
  return LocalPolicy.origin(url) ?? `${url.protocol}//${url.host}`
}

export interface Interface {
  readonly policy: () => Effect.Effect<LocalMode.Policy>
  readonly decide: (request: Request) => Effect.Effect<Decided>
  readonly fetch: (
    source: string,
    input: RequestInfo | URL,
    init?: FetchInit,
  ) => Effect.Effect<Response, EgressGuard.EgressBlocked | Error>
  readonly grant: (source: string, options?: { readonly once: boolean }) => Effect.Effect<void>
  readonly events: (filter?: Filter) => Effect.Effect<readonly LocalMode.Event[]>
  readonly summary: (rootID?: string) => Effect.Effect<LocalMode.Summary>
  readonly subscribe: (listener: (event: LocalMode.Event) => void) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Egress") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    policy: () => Effect.sync(policy),
    decide: (request) => Effect.sync(() => decide(request)),
    fetch: (source, input, init) =>
      Effect.tryPromise({
        try: () => fetch(source, input, init),
        catch: (cause) =>
          cause instanceof EgressGuard.EgressBlocked || cause instanceof Error ? cause : new Error(String(cause)),
      }),
    grant: (source, options) => Effect.sync(() => grant(source, options)),
    events: (filter) => Effect.sync(() => events(filter)),
    summary: (rootID) => Effect.sync(() => summary(rootID)),
    subscribe: (listener) => Effect.sync(() => subscribe(listener)),
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
