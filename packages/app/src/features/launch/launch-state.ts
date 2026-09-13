// Pure launch-screen controller. No DOM, no timers: given what the app has
// reported so far and how long the glass has been up, decide what it shows.
// launch-runtime.ts runs this from the first frame (vite.js inlines it), and
// the unit tests pin every rule so the glass can never get stuck.

export type LaunchPhase = "veiled" | "slow" | "failed" | "revealing" | "gone"

// Screens the app must show at once, without waiting for any ready signal.
export type LaunchYieldReason = "error" | "unreachable" | "license"

export type LaunchSignals = {
  // ms since the launch screen first painted
  elapsed: number
  // 800 on desktop, 0 on the web build (see minVisibleFor)
  minVisibleMs: number
  // NewLayout's shell has mounted and painted under the glass
  shellMounted: boolean
  // the engine answered: health reported healthy, or the path query loaded
  engineAnswered: boolean
  // global bootstrap (config, providers, path, projects) settled
  dataReady: boolean
  // persisted settings loaded, so theme and colours won't repaint after reveal
  settingsReady: boolean
  // ms since health first reported the engine unreachable; undefined while
  // it is healthy or unknown
  unhealthyFor?: number
  yielded?: LaunchYieldReason
  // the host saw signs the app bundle failed to load or evaluate (inferred,
  // so the ready signals still outrank it)
  bundleFailed?: boolean
  current: LaunchPhase
}

export const LAUNCH_TIMINGS = {
  // desktop minimum, so a warm start still shows the emblem settle
  MIN_VISIBLE_DESKTOP_MS: 800,
  MIN_VISIBLE_WEB_MS: 0,
  // slow-start hint; also the soft cap once the shell and engine are up
  SLOW_MS: 8_000,
  // watchdog: whatever else happened, the glass fails here
  HARD_MAX_MS: 60_000,
  // health must stay false this long before the app's offline state takes over
  UNHEALTHY_GRACE_MS: 3_000,
  // exit choreography length; the node is removed EXIT_MS + REMOVE_SLACK_MS
  // after revealing starts, by timer (a 0s transition fires no transitionend)
  EXIT_MS: 600,
  REMOVE_SLACK_MS: 40,
  // reduced motion replaces the choreography with a 200ms fade
  EXIT_REDUCED_MS: 200,
} as const

// localStorage keys the first frame reads before any app code has run.
export const LAUNCH_STORAGE_KEYS = {
  // mirrors written by LaunchSettingsMirror (launch-handoff.tsx)
  glass: "vector.glass",
  reduceAnimations: "vector.reduce-animations",
  // the real sidebar width (layout-new.tsx NAVIGATION_WIDTH_KEY), read only
  navigationWidth: "vector.navigation-width.v1",
} as const

export function minVisibleFor(platform: "desktop" | "web") {
  return platform === "desktop" ? LAUNCH_TIMINGS.MIN_VISIBLE_DESKTOP_MS : LAUNCH_TIMINGS.MIN_VISIBLE_WEB_MS
}

// Whether the real interface can take over, ignoring the minimum visible time.
function canReveal(input: LaunchSignals) {
  if (!input.shellMounted || !input.settingsReady) return false
  if (input.engineAnswered && input.dataReady) return true
  // Soft cap: the shell and engine are up and only data is still loading.
  // Home has its own skeletons for that.
  if (input.engineAnswered && input.elapsed >= LAUNCH_TIMINGS.SLOW_MS) return true
  // The engine is confirmed unreachable: hand over to the app's own offline
  // state ("Runtime offline"), the web counterpart of ConnectionError.
  if ((input.unhealthyFor ?? 0) >= LAUNCH_TIMINGS.UNHEALTHY_GRACE_MS) return true
  return false
}

export function decideLaunchPhase(input: LaunchSignals): LaunchPhase {
  // Monotonic: once revealing starts nothing can bring the glass back.
  if (input.current === "revealing" || input.current === "gone") return input.current
  // A blocking screen (ErrorPage, ConnectionError, licence activation) wins
  // over everything, including a failure and the minimum visible time.
  if (input.yielded) return "revealing"
  // A late recovery still reveals, even from the failed state and even after
  // a bundle failure: the host only infers one (an early uncaught error, a
  // failed module script), and a bundle that really failed never sends the
  // ready signals, so a wrong guess must not lock a working app behind the
  // failure screen.
  if (canReveal(input) && input.elapsed >= input.minVisibleMs) return "revealing"
  if (input.bundleFailed) return "failed"
  if (input.current === "failed") return "failed"
  if (input.elapsed >= LAUNCH_TIMINGS.HARD_MAX_MS) return "failed"
  if (input.elapsed >= LAUNCH_TIMINGS.SLOW_MS) return "slow"
  return "veiled"
}

// The next elapsed time at which decideLaunchPhase could change on its own,
// with no new signal. The runtime schedules one timer for it. Undefined once
// the phase can only change through a signal (or never).
export function nextLaunchDeadline(input: LaunchSignals): number | undefined {
  const phase = decideLaunchPhase(input)
  if (phase === "revealing" || phase === "gone") return undefined
  const candidates: number[] = []
  const later = (at: number) => {
    if (at > input.elapsed) candidates.push(at)
  }
  if (input.shellMounted && input.settingsReady) {
    if (input.engineAnswered && input.dataReady) later(input.minVisibleMs)
    if (input.engineAnswered) later(Math.max(LAUNCH_TIMINGS.SLOW_MS, input.minVisibleMs))
    if (input.unhealthyFor !== undefined) {
      const grace = input.elapsed + (LAUNCH_TIMINGS.UNHEALTHY_GRACE_MS - input.unhealthyFor)
      later(Math.max(grace, input.minVisibleMs))
    }
  }
  if (phase !== "failed") {
    later(LAUNCH_TIMINGS.SLOW_MS)
    later(LAUNCH_TIMINGS.HARD_MAX_MS)
  }
  if (candidates.length === 0) return undefined
  return Math.min(...candidates)
}
