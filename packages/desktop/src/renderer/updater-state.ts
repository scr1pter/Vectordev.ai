import type { UpdaterState } from "@vectordevai/app/updater"
import { createSignal } from "solid-js"

// The updater's state in this window. The desktop pushes its current state the moment a window subscribes, so the
// window renders only once that state has arrived (or after waitMs, so a stuck bridge never holds the window back).
// Rendering on the placeholder made an update that had already downloaded look as if it had just become ready, and
// the sidebar announced it on open.
export function subscribeUpdater(
  subscribe: (callback: (state: UpdaterState) => void) => Promise<unknown>,
  waitMs = 1_000,
) {
  const [state, setState] = createSignal<UpdaterState>({ status: "disabled" })
  const settled = Promise.race([
    subscribe(setState).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, waitMs)),
  ]).then(() => state())
  return { state, settled }
}
