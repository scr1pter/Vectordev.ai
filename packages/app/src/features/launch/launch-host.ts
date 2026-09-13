// Launch-screen host. vite.js compiles this file (with launch-state.ts) into
// one inline classic script in <head>, so it runs before the first frame:
// it stamps the glass, motion and tier attributes the CSS needs, then owns the
// #vector-launch overlay until it is removed. The app never touches the DOM
// here; it only reports signals through window.__vectorLaunch (see
// launch-bridge.ts), and decideLaunchPhase turns those into a phase.
//
// Safety, in order of last resort:
//   - revealing sets pointer-events none, inert, aria-hidden and no-drag at
//     once, and the node is removed by timer (never transitionend);
//   - a deadline timer re-runs decideLaunchPhase, whose hard cap fails the
//     glass at 60s with no signal at all;
//   - an independent watchdog fails it too, in case that logic ever threw;
//   - the CSS only shows the overlay while html[data-vector-launch] names a
//     live phase, and hides it after 90s in veiled/slow if this script died.

import {
  decideLaunchPhase,
  LAUNCH_STORAGE_KEYS,
  LAUNCH_TIMINGS,
  minVisibleFor,
  nextLaunchDeadline,
  type LaunchPhase,
  type LaunchSignals,
  type LaunchYieldReason,
} from "./launch-state"

export type LaunchSignal = "shell" | "engine" | "data" | "settings"

export type LaunchApi = {
  // the app rendered its root providers, so later uncaught errors are app
  // errors (the ErrorBoundary's business), not a failed bundle
  attach(): void
  signal(name: LaunchSignal, value?: boolean): void
  unhealthy(value: boolean): void
  yield(reason: LaunchYieldReason): void
  fail(): void
  phase(): LaunchPhase
  dispose(): void
}

type DesktopApi = { relaunch?: () => void; killSidecar?: () => Promise<unknown> }

export type LaunchWindow = Window & { api?: DesktopApi; __vectorLaunch?: LaunchApi }

export type LaunchOptions = {
  window?: LaunchWindow
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

export const LAUNCH_TEXT = {
  startingStatus: "Starting Vector",
  // Same wording as the vault error in desktop secure-runtime.ts (c918fa0f4).
  keychainHint: "Still starting. If macOS asks about “Vector Safe Storage”, choose Always Allow.",
  slowStatus: "Vector is still starting",
  failedStatus: "Vector didn’t finish starting",
} as const

// layout-new.tsx NAVIGATION_MINIMUM_WIDTH / NAVIGATION_MAXIMUM_WIDTH
const NAVIGATION_WIDTH = { min: 228, max: 460 }
const WATCHDOG_SLACK_MS = 250
// Live regions announce changes, not the content they are born with, and one
// filled the moment it appears is often missed: the status starts empty and
// gets "Starting Vector" this long after the host starts.
const ANNOUNCE_DELAY_MS = 100
const FLAGS = ["data-vector-launch-glass", "data-vector-launch-motion", "data-vector-launch-tier"]

export function startLaunchScreen(options: LaunchOptions = {}): LaunchApi {
  const win = options.window ?? (window as LaunchWindow)
  if (win.__vectorLaunch) return win.__vectorLaunch

  const doc = win.document
  const html = doc.documentElement
  const now = options.now ?? (() => win.performance.now())
  const later = options.setTimeout ?? ((fn: () => void, ms: number) => win.setTimeout(fn, ms))
  const cancel = options.clearTimeout ?? ((id: unknown) => win.clearTimeout(id as number))

  const read = (key: string) => {
    try {
      return win.localStorage.getItem(key)
    } catch {
      return null
    }
  }
  const media = (query: string) => {
    try {
      return win.matchMedia(query).matches
    } catch {
      return false
    }
  }

  const nav = win.navigator as Navigator & { deviceMemory?: number }
  const desktop = Boolean(win.api)
  const mac = /Mac/.test(nav.platform || "") || /Macintosh|Mac OS X/.test(nav.userAgent || "")
  const reducedMotion =
    read(LAUNCH_STORAGE_KEYS.reduceAnimations) === "true" || media("(prefers-reduced-motion: reduce)")

  if (read(LAUNCH_STORAGE_KEYS.glass) === "false" || media("(prefers-reduced-transparency: reduce)"))
    html.setAttribute("data-vector-launch-glass", "off")
  if (reducedMotion) html.setAttribute("data-vector-launch-motion", "reduced")
  if ((nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4)
    html.setAttribute("data-vector-launch-tier", "lite")
  const width = Number(read(LAUNCH_STORAGE_KEYS.navigationWidth))
  if (Number.isFinite(width) && width > 0) {
    const clamped = Math.min(NAVIGATION_WIDTH.max, Math.max(NAVIGATION_WIDTH.min, width))
    html.style.setProperty("--vector-launch-nav", `${clamped}px`)
  }

  const started = now()
  const minVisibleMs = minVisibleFor(desktop ? "desktop" : "web")
  const seen = { shell: false, engine: false, data: false, settings: false }
  let unhealthySince: number | undefined
  let yielded: LaunchYieldReason | undefined
  let bundleFailed = false
  let attached = false
  let phase: LaunchPhase = "veiled"
  let deadline: unknown
  let watchdog: unknown
  let removal: unknown
  let announcement: unknown
  let heldApp: HTMLElement | undefined

  const node = () => doc.getElementById("vector-launch")
  const stamp = (next: LaunchPhase) => {
    phase = next
    html.setAttribute("data-vector-launch", next)
    node()?.setAttribute("data-state", next)
  }
  const say = (text: string) => {
    const status = node()?.querySelector("[data-vector-launch-status]")
    if (status) status.textContent = text
  }
  const clear = (id: unknown) => {
    if (id !== undefined) cancel(id)
  }
  // #root while the opaque failure screen covers it: Tab and screen readers
  // must not reach what nobody can see. Only ever undoes its own inert.
  const holdApp = () => {
    const root = doc.getElementById("root")
    if (!root || root.inert) return
    root.inert = true
    heldApp = root
  }
  const releaseApp = () => {
    if (heldApp) heldApp.inert = false
    heldApp = undefined
  }

  const signals = (): LaunchSignals => {
    const at = now()
    return {
      elapsed: at - started,
      minVisibleMs,
      shellMounted: seen.shell,
      engineAnswered: seen.engine,
      dataReady: seen.data,
      settingsReady: seen.settings,
      unhealthyFor: unhealthySince === undefined ? undefined : at - unhealthySince,
      yielded,
      bundleFailed,
      current: phase,
    }
  }

  function slow() {
    const hint = node()?.querySelector("[data-vector-launch-hint]")
    // On a Mac desktop the usual cause is an unanswered Keychain prompt.
    if (hint && desktop && mac) hint.textContent = LAUNCH_TEXT.keychainHint
    say(LAUNCH_TEXT.slowStatus)
    stamp("slow")
  }

  function failed() {
    say(LAUNCH_TEXT.failedStatus)
    stamp("failed")
    const el = node()
    if (!el) return
    holdApp()
    const restart = el.querySelector<HTMLElement>('[data-vector-launch-action="restart"]')
    if (restart) restart.hidden = !win.api?.relaunch
    try {
      el.querySelector<HTMLElement>('[data-vector-launch-action="reload"]')?.focus({ preventScroll: true })
    } catch {}
  }

  function reveal() {
    clear(deadline)
    clear(watchdog)
    deadline = watchdog = undefined
    stamp("revealing")
    releaseApp()
    const el = node()
    if (el) {
      el.setAttribute("aria-hidden", "true")
      el.inert = true
      el.style.pointerEvents = "none"
    }
    // Timer, not transitionend: Reduce animations forces 0ms transitions
    // (index.css) and a 0s transition fires no event.
    const exit = reducedMotion ? LAUNCH_TIMINGS.EXIT_REDUCED_MS : LAUNCH_TIMINGS.EXIT_MS
    removal = later(finish, exit + LAUNCH_TIMINGS.REMOVE_SLACK_MS)
  }

  function finish() {
    removal = undefined
    node()?.remove()
    phase = "gone"
    html.setAttribute("data-vector-launch", "done")
    for (const flag of FLAGS) html.removeAttribute(flag)
    html.style.removeProperty("--vector-launch-nav")
    detach()
    try {
      win.dispatchEvent(new Event("vector:launch-done"))
    } catch {}
  }

  function enter(next: LaunchPhase) {
    if (next === "revealing") return reveal()
    if (next === "slow") return slow()
    if (next === "failed") return failed()
    stamp(next)
  }

  function schedule() {
    clear(deadline)
    deadline = undefined
    if (phase === "revealing" || phase === "gone") return
    const input = signals()
    const at = nextLaunchDeadline(input)
    if (at === undefined) return
    deadline = later(evaluate, Math.max(0, at - input.elapsed) + 1)
  }

  function evaluate() {
    if (phase === "revealing" || phase === "gone") return
    try {
      const next = decideLaunchPhase(signals())
      if (next !== phase) enter(next)
      schedule()
    } catch {
      // The watchdog below still fails the glass at the hard cap.
    }
  }

  const failBundle = () => {
    bundleFailed = true
    evaluate()
  }

  const onError = (event: Event) => {
    const target = event.target as (Node & { tagName?: string; type?: string }) | null
    if (target && (target as unknown) !== win && target.nodeType === 1) {
      // A resource failed. Only the app's module script matters, and only
      // before attach: without it nothing would ever hand off. After attach
      // the bundle evidently ran, so a failed module script is someone
      // else's.
      if (!attached && target.tagName === "SCRIPT" && target.type === "module") failBundle()
      return
    }
    // An uncaught error before the app rendered its root means the bundle
    // failed to evaluate. After attach, the ErrorBoundary owns errors.
    if (attached) return
    if (/ResizeObserver loop/i.test((event as ErrorEvent).message || "")) return
    failBundle()
  }

  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null
    const action = target?.closest?.("[data-vector-launch-action]")
    if (!action || !node()?.contains(action)) return
    event.preventDefault()
    const api = win.api
    if (action.getAttribute("data-vector-launch-action") === "restart" && api?.relaunch) {
      // Same as the desktop platform's restart (renderer/index.tsx).
      Promise.resolve()
        .then(() => api.killSidecar?.())
        .catch(() => undefined)
        .then(() => api.relaunch?.())
      return
    }
    win.location.reload()
  }

  function detach() {
    clear(deadline)
    clear(watchdog)
    clear(announcement)
    deadline = watchdog = announcement = undefined
    releaseApp()
    win.removeEventListener("error", onError, true)
    doc.removeEventListener("click", onClick)
  }

  win.addEventListener("error", onError, true)
  doc.addEventListener("click", onClick)
  watchdog = later(() => {
    watchdog = undefined
    if (phase === "veiled" || phase === "slow") enter("failed")
  }, LAUNCH_TIMINGS.HARD_MAX_MS + WATCHDOG_SLACK_MS)
  announcement = later(() => {
    announcement = undefined
    if (phase === "veiled") say(LAUNCH_TEXT.startingStatus)
  }, ANNOUNCE_DELAY_MS)

  const live = () => phase !== "revealing" && phase !== "gone"
  const api: LaunchApi = {
    attach() {
      attached = true
    },
    signal(name, value = true) {
      if (!live() || seen[name] === value) return
      seen[name] = value
      evaluate()
    },
    unhealthy(value) {
      if (!live()) return
      if (value && unhealthySince === undefined) unhealthySince = now()
      else if (!value && unhealthySince !== undefined) unhealthySince = undefined
      else return
      evaluate()
    },
    yield(reason) {
      if (!live()) return
      yielded = yielded ?? reason
      evaluate()
    },
    fail() {
      if (!live()) return
      failBundle()
    },
    phase: () => phase,
    dispose() {
      detach()
      clear(removal)
      removal = undefined
      if (win.__vectorLaunch === api) delete win.__vectorLaunch
    },
  }

  win.__vectorLaunch = api
  stamp("veiled")
  evaluate()
  return api
}
