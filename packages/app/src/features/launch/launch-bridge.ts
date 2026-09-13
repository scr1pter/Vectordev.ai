// The app's side of the launch screen: typed, crash-proof calls into the host
// that vite.js inlined (window.__vectorLaunch). Every call is a no-op when the
// host is absent (tests, a page without the plugin) or already gone, and a
// throw in it can never reach the app.

import type { LaunchApi, LaunchSignal } from "./launch-host"
import { LAUNCH_STORAGE_KEYS, type LaunchYieldReason } from "./launch-state"

function host(): LaunchApi | undefined {
  return (globalThis as { __vectorLaunch?: LaunchApi }).__vectorLaunch
}

function call(fn: (api: LaunchApi) => void) {
  const api = host()
  if (!api) return
  try {
    fn(api)
  } catch {}
}

export const launchScreen = {
  attach: () => call((api) => api.attach()),
  signal: (name: LaunchSignal, value = true) => call((api) => api.signal(name, value)),
  unhealthy: (value: boolean) => call((api) => api.unhealthy(value)),
  yield: (reason: LaunchYieldReason) => call((api) => api.yield(reason)),
}

// Hand a blocking screen (ErrorPage, ConnectionError, licence activation) the
// window right away, skipping every ready signal and the minimum visible time.
export function yieldLaunchScreen(reason: LaunchYieldReason) {
  launchScreen.yield(reason)
}

// Runs fn once the browser has painted what was just mounted, so the real
// shell is under the glass before it lifts. Two frames, with a timer fallback
// because hidden windows and background tabs never run requestAnimationFrame.
export function afterPaint(fn: () => void, fallbackMs = 120) {
  let done = false
  const run = () => {
    if (done) return
    done = true
    fn()
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(run))
  setTimeout(run, fallbackMs)
}

// Mirrors of settings the first frame of the next launch must know. Settings
// live in async platform storage on desktop, far too late for that frame.
export function writeLaunchPreferences(input: { glass: boolean; reduceAnimations: boolean }) {
  try {
    localStorage.setItem(LAUNCH_STORAGE_KEYS.glass, input.glass ? "true" : "false")
    localStorage.setItem(LAUNCH_STORAGE_KEYS.reduceAnimations, input.reduceAnimations ? "true" : "false")
  } catch {}
}
