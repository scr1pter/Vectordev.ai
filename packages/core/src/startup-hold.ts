export * as StartupHold from "./startup-hold"

// A desktop first run's hold on what Vector fetches for itself at start (plan section 4.7). Until the person has
// chosen how to run models, the desktop starts its engine with VECTOR_STARTUP_HOLD=1, and the model catalog's refresh,
// the free models and Codium plans catalogs and the provider policy wait; nothing else does, and it has no timeout.
// Once the person has chosen, desktop main lets them go (POST /local/startup/release), and each loads then, in the same
// engine: free models appear as soon as the person signs in, with no restart.
//
// The variable is read once and taken out of the environment, so a program the agent runs, or a nested vector, never
// starts held with no one to let it go. One state per process, shared by every copy of this module a bundle loads.

const VARIABLE = "VECTOR_STARTUP_HOLD"
const KEY = Symbol.for("vector.startup.hold")
const holder = globalThis as unknown as { [KEY]?: { held: boolean; listeners: Set<() => void> } }
const state = (holder[KEY] ??= { held: process.env[VARIABLE] === "1", listeners: new Set() })
delete process.env[VARIABLE]

/** Whether this process still holds its startup fetches. */
export function held() {
  return state.held
}

/** Lets the held fetches go; false when nothing was held. */
export function release() {
  if (!state.held) return false
  state.held = false
  const listeners = [...state.listeners]
  state.listeners.clear()
  listeners.forEach((listener) => listener())
  return true
}

/**
 * Runs `listener` once the hold is released, so a fetch it held runs then. Without a hold it never runs: nothing waited.
 * Returns the function that stops waiting.
 */
export function onRelease(listener: () => void) {
  if (!state.held) return () => undefined
  state.listeners.add(listener)
  return () => {
    state.listeners.delete(listener)
  }
}

/** Tests only: start held, or not, as a desktop first run's engine would. */
export function useTestHold(held: boolean) {
  state.held = held
  state.listeners.clear()
}
