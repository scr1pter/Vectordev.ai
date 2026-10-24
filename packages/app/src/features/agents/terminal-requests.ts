import { onCleanup } from "solid-js"
import type { TerminalCommand } from "@/context/terminal"

/* The launcher lives in the app shell, above any session, and the built-in terminal belongs to the session page that
   is open. A launcher hands a command over here, and the open session page's terminal runs it in a new tab it then
   shows. A command no terminal can take right now is refused rather than queued, so it never starts later out of
   sight; the caller runs it where the user is looking instead. */

export type TerminalRequest = {
  command: TerminalCommand
  /** Told whether the terminal could start the command, so a failure is never silent. */
  onStart?: (started: boolean) => void
  onExit?: (exitCode: number) => void
}

type Surface = { ready: () => boolean; run: (request: TerminalRequest) => void }

const surfaces: Surface[] = []

/** Whether a session page's terminal is mounted and ready to take a command. */
export function terminalSurfaceOpen() {
  return surfaces.some((surface) => surface.ready())
}

/** Hands a command to the open session's terminal, the most recently mounted one first. False when none is ready. */
export function requestTerminalRun(request: TerminalRequest) {
  const surface = surfaces.findLast((item) => item.ready())
  if (!surface) return false
  surface.run(request)
  return true
}

/** Registers the caller as a terminal that runs handed-over commands while `ready` holds. Call it once, in the
    component that owns the session's terminal. */
export function useTerminalRequests(surface: Surface) {
  surfaces.push(surface)
  onCleanup(() => surfaces.splice(surfaces.indexOf(surface), 1))
}
