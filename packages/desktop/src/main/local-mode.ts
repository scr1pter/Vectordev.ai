import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import tls from "node:tls"
import type { App, CommandLine, Session, WebContents } from "electron"
import { Option, Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { LocalStartup } from "@vectordevai/core/local-mode/startup"
import { decideChromium, egressFilter, type EgressFilter, type Target } from "./egress-filter"
import { companyCertificates } from "./local-certificates"
import { desktopLocalFolders, resolveDesktopLocal } from "./local-policy"

// Vector Local in the desktop app (plan sections 4.2, 4.3.6, 4.7 and 4.9). Desktop main resolves the policy before
// app.whenReady from the folders its engine reads (local-policy.ts), and from then on:
// - Chromium: one dispatcher per session (egress-filter.ts), WebRTC kept to the proxy, no DNS prefetching, no
//   spellcheck downloads on Windows and Linux, and no WebRTC peer connections in the agent's browser;
// - the company's certificate authorities are added to the certificates desktop main and its engine trust;
// - once the engine runs, desktop main compares its policy with the engine's (GET /local), and when they differ it
//   uses the stricter of the two and says so; and it sends what its own windows and requests did to the engine's
//   network log (POST /local/egress/report), so "What Vector sent" lists the desktop's requests too;
// - on the first run, with no company policy and no model connected, the requests Vector makes for itself at start
//   (the usage check-in, the update check, the dictation model's pre-warm, release notes and the model catalog's
//   refresh) wait until the person has chosen how to run models, with no timeout;
// - the services desktop main reaches (usage, updates, the help assistant) ask Vector Local before they connect.

const AGENT_BROWSER = "persist:vector-browser"
// electron-updater's own session (electronHttpExecutor.js, NET_SESSION_NAME), made with the options it makes it with.
const UPDATER = "electron-updater"
const UPDATER_OPTIONS = { cache: false }
const REPORT_BATCH = 500
const REPORT_LIMIT = 2_000
const RETRY = 5_000
const RECHECK = 30_000
const FIRST_RUN_CHECK = 15_000
const CERTIFICATES_CHECK = 60_000
const ANSWERED = "firstRunAnswered"
/** Desktop main's own store for Vector Local: whether the first run's question was answered. */
export const LOCAL_STORE = "local"
// What the app's windows fetch from the internet, by registry source, as the dispatcher decides it.
const RENDERER = {
  "release-notes": "https://vectordev.ai/changelog.json",
  "site-assets": "https://vectordev.ai/favicon-96x96-desktop-v4.png",
  "crash-reports": "https://ingest.sentry.io/",
  "dictation-model": "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json",
} as const

/** Vector Local as the app's windows see it (preload `vectorLocal.status`). */
export type DesktopLocalStatus = {
  readonly enabled: boolean
  readonly web: LocalMode.Web
  readonly lock: boolean
  /** The first run's own startup requests are waiting for the person to choose how to run models. */
  readonly held: boolean
  /** The app and its engine read Vector Local differently; the app uses the stricter of the two. */
  readonly mismatch?: string
  /** Whether the app's windows may fetch each of these from the internet now: allow, ask (once) or block. */
  readonly sources: Readonly<Record<keyof typeof RENDERER, LocalMode.Decision>>
}

export type Engine = { readonly url: string; readonly password: string }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const state: { mismatch?: string; hold: FirstRunHold } = { hold: createFirstRunHold(false) }

/**
 * Before app.whenReady, once preferAppEnv has set the desktop's folders: resolves Vector Local's policy, trusts the
 * company's certificate authorities, and keeps Chromium from resolving names a page links to before anyone opens them.
 */
export function startDesktopLocal(input: {
  readonly userData: string
  readonly commandLine: Pick<CommandLine, "appendSwitch">
  readonly log: (message: string, data?: unknown) => void
}) {
  const policy = resolveDesktopLocal(input.userData)
  // Chromium may still look up a name a page names, before the request the dispatcher would refuse.
  if (policy.enabled) input.commandLine.appendSwitch("dns-prefetch-disable")
  policy.warnings.forEach((warning) => input.log("vector local", { warning }))
  // Node's own certificate lists are read through OpenSSL and the system's store, either of which can fail on a
  // broken installation; Vector then keeps the certificates Node starts with.
  const trusted = (() => {
    try {
      return trustCompanyCertificates(input.userData)
    } catch (error) {
      input.log("failed to load system certificates", { error: String(error) })
      return undefined
    }
  })()
  trusted?.problems.forEach((problem) => input.log("company certificate skipped", { problem }))
  if (trusted?.added.length) input.log("company certificates trusted", { count: trusted.added.length })
  return policy
}

/**
 * The certificates Node trusts in this process: its bundled list and the system's, with the company's certificate
 * authorities (`local.ca.files`) added after them.
 */
export function trustCompanyCertificates(
  userData: string,
  apply: (certificates: string[]) => void = (certificates) => tls.setDefaultCACertificates(certificates),
  folders: LocalStartup.Input = desktopLocalFolders(userData),
) {
  const base = [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]
  const trusted = companyCertificates(base, LocalStartup.ca(folders))
  apply(trusted.certificates)
  return trusted
}

/**
 * Checks the company's certificate files every minute, and when the authorities they hold change, trusts the new set
 * here and calls `changed` (the engine restarts to trust them too). Returns the function that stops checking.
 */
export function watchCompanyCertificates(input: {
  readonly userData: string
  readonly changed: () => void
  readonly interval?: number
  readonly apply?: (certificates: string[]) => void
  readonly folders?: LocalStartup.Input
}) {
  const folders = input.folders ?? desktopLocalFolders(input.userData)
  const fingerprint = () => companyCertificates([], LocalStartup.ca(folders)).added.join()
  const last = { value: fingerprint() }
  const timer = setInterval(() => {
    const next = fingerprint()
    if (next === last.value) return
    last.value = next
    trustCompanyCertificates(input.userData, input.apply, folders)
    input.changed()
  }, input.interval ?? CERTIFICATES_CHECK)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Once the app is ready: the dispatcher on the default session and every session Electron makes, the kinds of the
 * sessions Vector knows, WebRTC kept to the proxy on every web contents, and, with Vector Local on, no WebRTC peer
 * connections in the agent's browser.
 */
export function installChromiumLocal(deps: {
  readonly app: Pick<App, "on">
  readonly defaultSession: Target
  readonly fromPartition: (partition: string, options?: { cache: boolean }) => Target & Partial<PreloadTarget>
  readonly webContents: () => readonly Pick<WebContents, "setWebRTCIPHandlingPolicy">[]
  /** Where the agent's browser's preload is written. */
  readonly directory: string
  readonly filter?: EgressFilter
  readonly policy?: () => LocalMode.Policy
}) {
  const filter = deps.filter ?? egressFilter
  const policy = deps.policy ?? Egress.policy
  filter.prepare(deps.defaultSession, "app")
  deps.app.on("session-created", (created) => filter.prepare(created))
  const agent = deps.fromPartition(AGENT_BROWSER)
  filter.prepare(agent, "agent-browser")
  filter.prepare(deps.fromPartition(UPDATER, UPDATER_OPTIONS), "updates")
  deps.app.on("web-contents-created", (_event, contents) => filter.protect(contents))
  deps.webContents().forEach((contents) => filter.protect(contents))
  if (policy().enabled && agent.registerPreloadScript) denyPeerConnections(agent as PreloadTarget, deps.directory)
}

type PreloadTarget = Pick<Session, "registerPreloadScript">

// Before a page's own scripts, in the page's world: no WebRTC peer connections, whose traffic no webRequest listener
// sees. A sandboxed preload with context isolation reaches the page's world through executeInMainWorld; one without
// isolation already runs there. Electron runs a session's preloads in each page's main frame, so a frame a page's own
// script makes still has RTCPeerConnection (the Electron smoke reports it); the IP handling policy holds that one to
// no proxy at all.
const PEER_CONNECTIONS_OFF = `"use strict"
// Vector Local: the agent's browser makes no WebRTC peer connections. Written by Vector (local-mode.ts).
const off = () => {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) {
    try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false, writable: false }) } catch {}
  }
}
try { require("electron").contextBridge.executeInMainWorld({ func: off }) } catch { off() }
`

/** Registers the preload that turns WebRTC peer connections off in the pages of `target`. */
export function denyPeerConnections(target: PreloadTarget, directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filePath = join(directory, "no-peer-connections.js")
  writeFileSync(filePath, PEER_CONNECTIONS_OFF, { mode: 0o600 })
  return target.registerPreloadScript({ type: "frame", id: "vector-local-no-peer-connections", filePath })
}

/** Why the app and its engine disagree about Vector Local, and the stricter policy of the two; undefined when they agree. */
export function policyMismatch(desktop: LocalMode.Policy, engine: LocalMode.Policy) {
  const on = (policy: LocalMode.Policy) => (policy.enabled ? "on" : "off")
  const differences =
    desktop.enabled !== engine.enabled
      ? [`Vector Local is ${on(desktop)} in the app and ${on(engine)} in its engine`]
      : desktop.enabled
        ? [
            desktop.web !== engine.web
              ? `Web access is ${WEB_LABEL[desktop.web]} in the app and ${WEB_LABEL[engine.web]} in its engine`
              : undefined,
            same(endpoints(desktop), endpoints(engine)) ? undefined : "their model server lists differ",
            same(allowed(desktop), allowed(engine)) ? undefined : "their allowed services differ",
            same(desktop.web_domains.allow, engine.web_domains.allow) &&
            same(desktop.web_domains.deny, engine.web_domains.deny)
              ? undefined
              : "their site lists differ",
            desktop.updates?.url === engine.updates?.url ? undefined : "their update mirrors differ",
            desktop.lock === engine.lock ? undefined : "only one of them follows your company's lock",
          ].filter((item): item is string => item !== undefined)
        : []
  if (differences.length === 0) return undefined
  return {
    differences,
    message: `The app and its engine read Vector Local differently: ${differences.join("; ")}. The app uses the stricter of the two until they agree, which usually takes a restart of Vector.`,
    stricter: stricterPolicy(desktop, engine),
  }
}

const WEB_LABEL: Record<LocalMode.Web, string> = { ask: "Ask", network: "Your network only", none: "None" }

/** The policy that lets through only what both let through. */
export function stricterPolicy(left: LocalMode.Policy, right: LocalMode.Policy): LocalMode.Policy {
  if (!left.enabled) return right
  if (!right.enabled) return left
  const listed = endpoints(right)
  const services = allowed(right)
  const pending = left.pending || right.pending
  return {
    ...left,
    web: LocalPolicy.stricter(left.web, right.web),
    lock: left.lock || right.lock,
    ...(pending ? { pending } : {}),
    endpoints: left.endpoints.filter((endpoint) => listed.includes(endpointKey(endpoint))),
    web_domains: {
      allow: left.web_domains.allow.filter((site) => right.web_domains.allow.includes(site)),
      deny: [...new Set([...left.web_domains.deny, ...right.web_domains.deny])],
    },
    allow: left.allow.filter((entry) => services.includes(allowKey(entry))),
    ...(left.updates && left.updates.url === right.updates?.url ? { updates: left.updates } : { updates: undefined }),
    user_may: left.user_may.filter((key) => right.user_may.includes(key)),
    locked_keys: [...new Set([...left.locked_keys, ...right.locked_keys])],
    endpoint_domains: left.endpoint_domains.filter((pattern) => right.endpoint_domains.includes(pattern)),
  }
}

const endpointKey = (endpoint: LocalMode.Endpoint) =>
  endpoint.from === "managed" ? `managed ${endpoint.origin}` : (LocalPolicy.origin(endpoint.origin) ?? endpoint.origin)
const endpoints = (policy: LocalMode.Policy) => policy.endpoints.map(endpointKey)
const allowKey = (entry: LocalMode.Allowed) => `${entry.source} ${[...(entry.hosts ?? [])].sort().join(",")}`
const allowed = (policy: LocalMode.Policy) => policy.allow.map(allowKey)
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n")

/**
 * Once the engine answers: compares its policy with this process's every half minute (Vector Local turned on in the
 * app applies here at once, as the stricter policy), and sends this process's network log lines to the engine's log.
 * Returns how to stop both.
 */
export function connectDesktopLocal(input: {
  readonly engine: Engine
  readonly log: (message: string, data?: unknown) => void
  readonly fetch?: Fetch
  readonly interval?: number
}) {
  const fetch = input.fetch ?? globalThis.fetch
  const own = Egress.policy()
  const compare = async () => {
    const engine = await readEnginePolicy(input.engine, fetch)
    if (!engine) return
    const mismatch = policyMismatch(own, engine)
    if (mismatch?.message === state.mismatch) return
    input.log("vector local", { mismatch: mismatch?.message ?? "none" })
    state.mismatch = mismatch?.message
    // What started with this process (DNS prefetching, the agent browser's peer connections) changes at the next start.
    Egress.configure(mismatch?.stricter ?? own)
  }
  const first = compare()
  const timer = setInterval(() => void compare(), input.interval ?? RECHECK)
  timer.unref?.()
  const forward = forwardEgress({
    // What this process logged before its engine answered, then each line as it is logged.
    initial: Egress.events(),
    subscribe: Egress.subscribe,
    send: (events) =>
      fetch(new URL("/local/egress/report", input.engine.url).href, {
        method: "POST",
        headers: { ...authorization(input.engine), "content-type": "application/json" },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      }).then(
        async (response) => {
          await response.body?.cancel().catch(() => undefined)
          return response.ok
        },
        () => false,
      ),
  })
  return {
    /** The first comparison, settled once the engine answered or could not. */
    compared: first,
    compare,
    stop() {
      clearInterval(timer)
      forward.stop()
    },
  }
}

async function readEnginePolicy(engine: Engine, fetch: Fetch) {
  const response = await fetch(new URL("/local", engine.url).href, {
    headers: authorization(engine),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => undefined)
    return undefined
  }
  return Option.getOrUndefined(Schema.decodeUnknownOption(EngineStatus)(await response.json().catch(() => undefined)))
    ?.policy
}

// The part of GET /local's answer the comparison reads.
const EngineStatus = Schema.Struct({ policy: LocalMode.Policy })

function authorization(engine: Engine) {
  return { authorization: `Basic ${Buffer.from(`vector:${engine.password}`).toString("base64")}` }
}

/**
 * Sends each event this process records to `send`, in batches, a second after the first of a batch. A batch the
 * engine did not take is sent again later; the oldest are dropped past `limit`, as the engine's own memory does.
 */
export function forwardEgress(deps: {
  readonly initial?: readonly LocalMode.Event[]
  readonly subscribe: (listener: (event: LocalMode.Event) => void) => () => void
  readonly send: (events: readonly LocalMode.Event[]) => Promise<boolean>
  readonly delay?: number
  readonly retry?: number
  readonly limit?: number
}) {
  const queue: LocalMode.Event[] = (deps.initial ?? []).slice(-(deps.limit ?? REPORT_LIMIT))
  const status: { timer?: ReturnType<typeof setTimeout>; sending: boolean; stopped: boolean } = {
    sending: false,
    stopped: false,
  }
  const schedule = (delay: number) => {
    if (status.timer || status.stopped) return
    status.timer = setTimeout(() => void flush(), delay)
    status.timer.unref?.()
  }
  const flush = async () => {
    status.timer = undefined
    if (status.sending || queue.length === 0) return
    status.sending = true
    const batch = queue.splice(0, REPORT_BATCH)
    const sent = await deps.send(batch).catch(() => false)
    if (!sent) queue.unshift(...batch.slice(Math.max(0, batch.length + queue.length - (deps.limit ?? REPORT_LIMIT))))
    status.sending = false
    if (queue.length > 0) schedule(sent ? 0 : (deps.retry ?? RETRY))
  }
  const unsubscribe = deps.subscribe((event) => {
    queue.push(event)
    if (queue.length > (deps.limit ?? REPORT_LIMIT)) queue.splice(0, queue.length - (deps.limit ?? REPORT_LIMIT))
    schedule(deps.delay ?? 1_000)
  })
  if (queue.length > 0) schedule(0)
  return {
    flush,
    stop() {
      status.stopped = true
      unsubscribe()
      clearTimeout(status.timer)
    },
  }
}

export type FirstRunHold = ReturnType<typeof createFirstRunHold>

/**
 * The first run's hold on the requests Vector makes for itself at start. It has no timeout: it holds until `answer`,
 * and dismissing the card that asks leaves it holding, at this start and the next.
 */
export function createFirstRunHold(held: boolean) {
  const answered = Promise.withResolvers<void>()
  const status = { held }
  if (!held) answered.resolve()
  return {
    held: () => status.held,
    /** Resolves once the person has chosen how to run models. */
    answered: () => answered.promise,
    answer() {
      if (!status.held) return false
      status.held = false
      answered.resolve()
      return true
    },
  }
}

/**
 * Whether this start holds the requests Vector makes for itself: on a first run, with no company policy (which says
 * how Vector runs before the app is ready) and Vector Local not already on, until the person chooses how to run models.
 * An install that has already checked in (`reported`) has run before.
 */
export function firstRunHeld(input: {
  readonly answered: boolean
  readonly managed: boolean
  readonly enabled: boolean
  readonly reported: boolean
}) {
  return !input.answered && !input.managed && !input.enabled && !input.reported
}

/** Decides this start's first-run hold, from the desktop's own records and its folders. */
export function startFirstRun(input: {
  readonly userData: string
  readonly store: { get(key: string): unknown; set(key: string, value: unknown): void }
  readonly reported: boolean
  readonly folders?: LocalStartup.Input
}) {
  const held = firstRunHeld({
    answered: input.store.get(ANSWERED) === true,
    managed: LocalStartup.managed(input.folders ?? desktopLocalFolders(input.userData)),
    enabled: Egress.policy().enabled,
    reported: input.reported,
  })
  state.hold = createFirstRunHold(held)
  if (held) void state.hold.answered().then(() => input.store.set(ANSWERED, true))
  return state.hold
}

/** The hold this start decided. */
export function firstRun() {
  return state.hold
}

/**
 * While the hold holds, asks every 15 seconds whether the person has chosen how to run models: a model connected (an
 * API key, a model server, or free models after signing in to Vector), or Vector Local turned on. It never gives up on
 * its own. Returns the function that stops asking.
 */
export function watchFirstRun(
  hold: FirstRunHold,
  input: {
    readonly answered: () => Promise<boolean>
    readonly interval?: number
  },
) {
  const status: { timer?: ReturnType<typeof setTimeout>; stopped: boolean } = { stopped: false }
  const check = async () => {
    status.timer = undefined
    if (status.stopped || !hold.held()) return
    if (await input.answered().catch(() => false)) return void hold.answer()
    if (status.stopped) return
    status.timer = setTimeout(() => void check(), input.interval ?? FIRST_RUN_CHECK)
    status.timer.unref?.()
  }
  void check()
  return () => {
    status.stopped = true
    clearTimeout(status.timer)
  }
}

/** Whether the person has chosen how to run models, as the engine and the Vector account tell it. */
export async function answeredByEngine(engine: Engine, signedIn: () => boolean, fetch: Fetch = globalThis.fetch) {
  if (signedIn()) return true
  const read = (path: string) =>
    fetch(new URL(path, engine.url).href, { headers: authorization(engine), signal: AbortSignal.timeout(10_000) })
      .then((response) => (response.ok ? response.json() : undefined))
      .catch(() => undefined) as Promise<unknown>
  const [providers, local] = await Promise.all([read("/provider"), read("/local")])
  const connected = (providers as { connected?: unknown } | undefined)?.connected
  if (Array.isArray(connected) && connected.length > 0) return true
  return (local as { policy?: { enabled?: unknown } } | undefined)?.policy?.enabled === true
}

/**
 * Whether the usage check-in may go now: not while the first run's hold holds, and with Vector Local on only when the
 * user allowed it. Its request still goes through Egress, which decides where it goes.
 */
export function usageCheckinAllowed(endpoint: string) {
  if (state.hold.held()) return false
  return (
    LocalPolicy.decide(Egress.policy(), { purpose: "usage", url: endpoint, source: "usage-checkin" }).decision ===
    "allow"
  )
}

/**
 * Vector Local's say over the updater: automatic checks run only when no first-run hold holds and Vector Local allows
 * them (off, or a company mirror); a check the user asks for asks first with Vector Local on, every time, and then lets
 * the updater's session reach the feed while it runs.
 */
export function createUpdateGate(deps: {
  readonly feed: () => string | undefined
  /** Asks the person; true to go ahead. */
  readonly ask: (question: { readonly message: string; readonly detail: string }) => Promise<boolean>
  /** Tells the person why a check cannot run. */
  readonly tell: (notice: { readonly message: string; readonly detail: string }) => Promise<void>
  /** Runs `run` while the updater's session may reach `origins`. */
  readonly during: <T>(origins: readonly string[], run: () => Promise<T>) => Promise<T>
  readonly policy?: () => LocalMode.Policy
  readonly held?: () => boolean
}) {
  const policy = deps.policy ?? Egress.policy
  const held = deps.held ?? (() => state.hold.held())
  const decide = (manual: boolean) =>
    LocalPolicy.decide(policy(), {
      purpose: "updates",
      url: deps.feed() ?? "https://vectordev.ai/",
      source: "updates",
      manual,
    })
  return {
    automatic: () => !held() && decide(false).decision === "allow",
    async manual() {
      const verdict = decide(true)
      if (verdict.decision === "allow") return true
      if (verdict.decision === "ask")
        return deps.ask({
          message: "Check for updates with Vector Local on?",
          detail:
            "Vector Local turns off automatic update checks. This check sends your Vector version and platform to Vector's update server, this once.",
        })
      await deps.tell({
        message: "Vector does not check for updates now",
        detail: `${verdict.reason} Change Web access, then check again.`,
      })
      return false
    },
    run<T>(run: () => Promise<T>) {
      const feed = deps.feed()
      if (!policy().enabled || !feed) return run()
      return deps.during([feed], run)
    },
  }
}

export type UpdateGate = ReturnType<typeof createUpdateGate>

/** Lets the updater's session reach `origins` while `run` runs. */
export function duringUpdateCheck<T>(
  fromPartition: (partition: string, options?: { cache: boolean }) => Target,
  origins: readonly string[],
  run: () => Promise<T>,
) {
  return egressFilter.allowing(fromPartition(UPDATER, UPDATER_OPTIONS), origins, run)
}

/** Vector Local as the app's windows see it. */
export function desktopLocalStatus(): DesktopLocalStatus {
  const policy = Egress.policy()
  const decide = (url: string) => decideChromium({ url, kind: "app", policy }).decision
  return {
    enabled: policy.enabled,
    web: policy.web,
    lock: policy.lock,
    held: state.hold.held(),
    ...(state.mismatch ? { mismatch: state.mismatch } : {}),
    sources: {
      "release-notes": decide(RENDERER["release-notes"]),
      "site-assets": decide(RENDERER["site-assets"]),
      "crash-reports": decide(RENDERER["crash-reports"]),
      "dictation-model": decide(RENDERER["dictation-model"]),
    },
  }
}
