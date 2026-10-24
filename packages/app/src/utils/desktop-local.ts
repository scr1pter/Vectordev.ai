// Vector Local as the desktop app's main process holds it (window.api.vectorLocal), for the requests the app's own
// windows make for themselves: release notes, the dictation model. Main's dispatcher decides every one of them anyway;
// asking first keeps the app from making a request it would refuse, and from showing the refusal as a failure.

export type DesktopLocal = {
  readonly enabled: boolean
  /** A first run's startup requests wait until the person has chosen how to run models. */
  readonly held: boolean
  /**
   * Vector Local was turned on after the app started; Chromium's DNS prefetching and QUIC stay on until Vector
   * restarts.
   */
  readonly restartNeeded?: boolean
  /** What Vector Local does with a request of the app's own, by its source: allow, ask (once) or block. */
  readonly sources: Readonly<Record<string, "allow" | "ask" | "block">>
}

/** Vector Local in this desktop app; undefined outside the desktop app, or from one that predates it. */
export async function desktopLocal(): Promise<DesktopLocal | undefined> {
  return (await globalThis.window?.api?.vectorLocal?.status().catch(() => undefined)) ?? undefined
}

/** Whether the app may make a request of its own for `source` now: no first-run hold, and Vector Local allows it. */
export function mayFetch(local: DesktopLocal | undefined, source: string) {
  if (!local) return true
  return !local.held && local.sources[source] === "allow"
}

/**
 * Runs `run` with the status once the first run's hold no longer holds: at once when nothing is held or outside the
 * desktop app, otherwise once the person has chosen how to run models (asked every 15 seconds, with no timeout), so
 * what the hold kept back still happens in this window. Returns the function that stops waiting.
 */
export function afterFirstRun(run: (local: DesktopLocal | undefined) => void, interval = 15_000) {
  const state: { timer?: ReturnType<typeof setTimeout>; stopped: boolean } = { stopped: false }
  const check = async () => {
    const local = await desktopLocal()
    if (state.stopped) return
    if (!local?.held) return run(local)
    state.timer = setTimeout(() => void check(), interval)
  }
  void check()
  return () => {
    state.stopped = true
    clearTimeout(state.timer)
  }
}
