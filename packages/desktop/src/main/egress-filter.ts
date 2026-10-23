import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { CallbackResponse, OnBeforeRequestListenerDetails, Session, WebContents } from "electron"

// Vector Local in Chromium (plan section 4.3.6). The backstop guard sees the desktop's own Node requests, but not what
// Chromium loads for Vector's windows, the agent's browser, the research browsers or the updater, so every Chromium
// session gets one dispatcher on webRequest.onBeforeRequest. Electron keeps one listener per event per session, so
// nothing else may call onBeforeRequest itself: a window that needs one of its own (the billing window, the research
// browsers) registers a step here, which runs after Vector Local's own decision and only when that decision lets the
// request go. `decideChromium` is that decision, as a pure function of the address, the kind of session and the policy
// in effect. With Vector Local off it lets everything through and logs nothing, and the steps run as they would alone.

/** What a Chromium session is for, which says what Vector Local lets it reach. */
export type Kind = "app" | "agent-browser" | "research-browser" | "updates" | "billing" | "other"

/** Vector Local's decision for one request, with the registry source it is logged as. */
export type Decision = LocalPolicy.Verdict & { readonly source: string; readonly purpose: LocalMode.Purpose }

/** A listener as Electron's onBeforeRequest takes it, so a window's own listener registers here unchanged. */
export type Step = (details: OnBeforeRequestListenerDetails, callback: (response: CallbackResponse) => void) => void

export type Target = Pick<Session, "webRequest"> & Partial<Pick<Session, "setSpellCheckerEnabled">>

// The renderer's own scheme (windows.ts, rendererProtocol), which serves the app's files from disk.
const APP_SCHEME = "oc:"
// Addresses that stay on this computer: files, the app's own pages, in-memory data and the browser's own pages.
const LOCAL_SCHEMES = new Set([
  "file:",
  "data:",
  "blob:",
  "about:",
  "devtools:",
  "chrome:",
  "chrome-error:",
  "chrome-extension:",
  APP_SCHEME,
])
// A research browser holds only web pages: in-memory data for what a page builds itself, and blank or inline frames,
// which inherit their parent (section 5.6a). Its own files, the app's pages and the browser's are never its to load.
const RESEARCH_SCHEMES = new Set(["data:", "blob:", "about:"])
const WEB_KINDS = new Set<Kind>(["agent-browser", "research-browser"])
// One record per host per page is enough for the log, so a page's hundreds of requests are a handful of lines.
const SEEN_LIMIT = 256
const STAY = "This stays on this computer."
const PRIVATE_REASON = "Research browsers never reach this computer, your network or a cloud metadata address."

/**
 * Whether Vector Local lets a Chromium session of `kind` load `url`. Vector's own windows reach this computer, its
 * files and pages, the Vector servers on your network and the model servers on the list; what the app itself fetches
 * from the internet (release notes, crash reports, the dictation model) is decided as the registry source it is. The
 * agent's browser and the research browsers follow Web access, and a research browser never reaches this computer or
 * your network. The updater's session checks for updates only as `updates` allows, or for an origin the user just
 * asked to check (`granted`). Anything else is a request no part of Vector labelled, which reaches only this computer
 * and the list.
 */
export function decideChromium(input: {
  readonly url: string
  readonly kind: Kind
  readonly policy: LocalMode.Policy
  /** Origins this session may reach for now, such as the update feed of a check the user asked for. */
  readonly granted?: Pick<ReadonlySet<string>, "has">
}): Decision {
  const labelled = label(input.kind, input.url)
  const decision = (
    verdict: Omit<LocalPolicy.Verdict, "allowable"> & { allowable?: boolean },
    source = labelled.source,
    purpose = labelled.purpose,
  ): Decision => ({ allowable: false, ...verdict, source, purpose })
  if (!URL.canParse(input.url))
    return decision({ decision: "block", rule: "unlabelled", class: "internet", reason: "This is not an address." })
  const url = new URL(input.url)
  const local = input.kind === "research-browser" ? RESEARCH_SCHEMES : LOCAL_SCHEMES
  if (!input.policy.enabled)
    return decision({ decision: "allow", rule: "local-off", class: "this-computer", reason: "Vector Local is off." })
  if (local.has(url.protocol))
    return decision({ decision: "allow", rule: "loopback", class: "this-computer", reason: STAY })
  const web = webAddress(url)
  if (!web)
    return decision({
      decision: "block",
      rule: "unlabelled",
      class: "internet",
      reason:
        input.kind === "research-browser"
          ? "Research browsers load web pages only."
          : "Vector Local lets Vector's windows load web addresses and their own files only.",
    })
  const place = LocalPolicy.hostClass(web.hostname)
  if (input.kind === "research-browser" && place !== "internet")
    return decision({ decision: "block", rule: "private-destination", class: place, reason: PRIVATE_REASON })
  if (input.granted?.has(web.origin))
    return decision({
      decision: "allow",
      rule: "manual-check",
      class: LocalPolicy.classify(input.policy, web),
      reason: "You asked Vector to check for updates.",
    })
  // The app's windows talk to the Vector servers you connect them to: this computer's, WSL's and a build box's.
  if (labelled.source === "unlabelled" && input.kind === "app" && place === "your-network")
    return decision({
      decision: "allow",
      rule: "private-remote",
      class: LocalPolicy.classify(input.policy, web),
      reason: "Vector's windows reach Vector servers on this computer and your network.",
    })
  return decision(LocalPolicy.decide(input.policy, { purpose: labelled.purpose, url: web, source: labelled.source }))
}

/**
 * The dispatcher for every Chromium session: Vector Local's decision first, then the steps windows registered, in the
 * order they registered. Decisions are logged through `record` while Vector Local is on, one line per host per page
 * for what a page loads, and never for what stays on this computer.
 */
export function createEgressFilter(deps: {
  readonly policy: () => LocalMode.Policy
  readonly record: (request: Egress.Request, verdict: LocalPolicy.Verdict) => void
  readonly platform?: NodeJS.Platform
}) {
  type State = { kind: Kind; steps: Step[]; granted: Map<string, number> }
  const sessions = new WeakMap<Target, State>()
  // The page each web contents is on, counted up at each main-frame request, and the hosts logged for it.
  const pages = new Map<number, { page: number; requests: Set<number>; seen: Set<string> }>()

  const state = (target: Target, kind?: Kind) => {
    const known = sessions.get(target)
    if (known) {
      if (kind) known.kind = kind
      return known
    }
    const created: State = { kind: kind ?? "other", steps: [], granted: new Map() }
    sessions.set(target, created)
    target.webRequest.onBeforeRequest((details, callback) => dispatch(created, details, callback))
    const policy = deps.policy()
    // Chromium downloads spellcheck dictionaries from Google on Windows and Linux (macOS uses its own spellchecker).
    const platform = deps.platform ?? process.platform
    if (policy.enabled && (platform === "win32" || platform === "linux")) target.setSpellCheckerEnabled?.(false)
    return created
  }

  const dispatch = (
    session: State,
    details: OnBeforeRequestListenerDetails,
    callback: (response: CallbackResponse) => void,
  ) => {
    const policy = deps.policy()
    const decided = decideChromium({
      url: details.url,
      kind: session.kind,
      policy,
      granted: session.granted,
    })
    if (policy.enabled) log(session.kind, details, decided)
    if (decided.decision !== "allow") return callback({ cancel: true })
    // Electron holds a request until its listener answers, so a step that throws cancels it rather than hanging it.
    const run = (index: number): void => {
      const step = session.steps[index]
      if (!step) return callback({})
      try {
        step(details, (response) => {
          if (response.cancel || response.redirectURL) return callback(response)
          run(index + 1)
        })
      } catch {
        callback({ cancel: true })
      }
    }
    run(0)
  }

  const log = (kind: Kind, details: OnBeforeRequestListenerDetails, decided: Decision) => {
    if (decided.decision === "allow" && decided.class === "this-computer") return
    const contents = details.webContentsId ?? -1
    const known = pages.get(contents)
    const main = details.resourceType === "mainFrame"
    // A new main-frame request is a new page; a redirect hop of it is the same page reaching another host.
    const fresh = main && !known?.requests.has(details.id)
    const current =
      !known || fresh
        ? { page: (known?.page ?? 0) + 1, requests: new Set([details.id]), seen: new Set<string>() }
        : known
    if (current !== known) {
      pages.delete(contents)
      pages.set(contents, current)
      if (pages.size > SEEN_LIMIT) pages.delete(pages.keys().next().value!)
    }
    const origin = URL.canParse(details.url) ? new URL(details.url).origin : details.url
    const key = `${origin} ${decided.decision}`
    if (!fresh && current.seen.has(key)) return
    current.seen.add(key)
    deps.record(
      {
        source: decided.source,
        url: details.url,
        method: details.method,
        ...(WEB_KINDS.has(kind) ? { resource: fresh ? ("page" as const) : ("subresource" as const) } : {}),
      },
      decided,
    )
  }

  return {
    /** Puts the dispatcher on a session, once, and says what the session is for. */
    prepare(target: Target, kind?: Kind) {
      state(target, kind)
    },
    /**
     * Adds a window's own onBeforeRequest listener to a session, after Vector Local's decision. Returns the function
     * that takes it off again.
     */
    register(target: Target, step: Step, options: { readonly kind?: Kind } = {}) {
      const session = state(target, options.kind)
      session.steps.push(step)
      return () => {
        session.steps = session.steps.filter((item) => item !== step)
      }
    },
    /** Lets a session reach `origins` while `run` runs, such as the update feed of a check the user asked for. */
    async allowing<T>(target: Target, origins: readonly string[], run: () => Promise<T>) {
      const session = state(target)
      const named = [...new Set(origins.flatMap((item) => (URL.canParse(item) ? [new URL(item).origin] : [])))]
      named.forEach((origin) => session.granted.set(origin, (session.granted.get(origin) ?? 0) + 1))
      return await run().finally(() =>
        named.forEach((origin) => {
          const left = (session.granted.get(origin) ?? 1) - 1
          if (left > 0) return void session.granted.set(origin, left)
          session.granted.delete(origin)
        }),
      )
    },
    /**
     * Keeps a web contents' WebRTC to the proxy, under Vector Local: peer connections cannot reach the network around
     * the session's own proxy (none for the app and the agent's browser, the research proxy for research browsers).
     */
    protect(contents: Pick<WebContents, "setWebRTCIPHandlingPolicy">) {
      if (!deps.policy().enabled) return false
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
      return true
    },
  }
}

export type EgressFilter = ReturnType<typeof createEgressFilter>

/** The desktop's dispatcher, deciding with the policy desktop main resolved and logging to its network log. */
export const egressFilter = createEgressFilter({
  policy: () => Egress.policy(),
  record: (request, verdict) => void Egress.record(request, verdict),
})

// The registry source a request is decided and logged as, by the kind of session and what the address is.
function label(kind: Kind, input: string): { source: string; purpose: LocalMode.Purpose } {
  if (kind === "agent-browser") return { source: "agent-browser", purpose: "browser" }
  if (kind === "research-browser") return { source: "research-browser", purpose: "research-browser" }
  if (kind === "updates") return { source: "updates", purpose: "updates" }
  const url = URL.canParse(input) ? webAddress(new URL(input)) : undefined
  if (kind === "app" && url) {
    const host = url.hostname
    const vector = LocalPolicy.domainMatches(host, "vectordev.ai")
    if (vector && url.pathname === "/changelog.json") return { source: "release-notes", purpose: "release-notes" }
    if (vector && /\.(?:png|ico|svg|jpe?g|webp|gif)$/i.test(url.pathname))
      return { source: "site-assets", purpose: "asset" }
    if (LocalPolicy.domainMatches(host, "sentry.io")) return { source: "crash-reports", purpose: "crash" }
    if (["huggingface.co", "hf.co"].some((pattern) => LocalPolicy.domainMatches(host, pattern)))
      return { source: "dictation-model", purpose: "model-download" }
  }
  return { source: "unlabelled", purpose: "unknown" }
}

// A web address as Vector Local decides it: a WebSocket is the http or https address it starts from.
function webAddress(url: URL) {
  if (url.protocol === "http:" || url.protocol === "https:") return url
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined
  const web = new URL(url.href)
  web.protocol = url.protocol === "ws:" ? "http:" : "https:"
  return web
}
