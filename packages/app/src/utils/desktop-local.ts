// Vector Local as the desktop app's main process holds it (window.api.vectorLocal), for the requests the app's own
// windows make for themselves: release notes, the dictation model. Main's dispatcher decides every one of them anyway;
// asking first keeps the app from making a request it would refuse, and from showing the refusal as a failure.

export type DesktopLocal = {
  readonly enabled: boolean
  /** A first run's startup requests wait until the person has chosen how to run models. */
  readonly held: boolean
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
