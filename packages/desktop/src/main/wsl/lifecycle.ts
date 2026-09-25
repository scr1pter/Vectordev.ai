import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

export function wslLaunchEnvironment(source: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(
      Object.entries(untrustedChildEnvironment(source)).filter(
        ([key]) => !["BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "WSLENV"].includes(key.toUpperCase()),
      ),
    ),
    WSLENV: "",
  }
}

export function redactWslOutput(text: string, secrets: readonly string[]) {
  return secrets.filter(Boolean).reduce((value, secret) => value.split(secret).join("[redacted]"), text)
}

/** Closing the control pipe lets Bash stop its Linux process group before wsl.exe exits. */
export function wslProcessLifetime(child: ChildProcessWithoutNullStreams, timeoutMs = 6_000) {
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const state: { stopping?: Promise<void> } = {}
  return {
    exited,
    stop() {
      if (state.stopping) return state.stopping
      child.stdin.end()
      const timer = Promise.withResolvers<void>()
      const timeout = setTimeout(
        () =>
          timer.reject(
            new Error("Vector could not confirm that the WSL server stopped. Retry before changing accounts."),
          ),
        timeoutMs,
      )
      state.stopping = Promise.race([exited, timer.promise]).finally(() => {
        clearTimeout(timeout)
        state.stopping = undefined
      })
      return state.stopping
    },
  }
}
