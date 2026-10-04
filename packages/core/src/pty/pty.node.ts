import { createRequire } from "node:module"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

// Loaded on the first spawn, not imported: Bun.build hoists a static import of this external package to the top of the
// Node engine bundle, and @lydell/node-pty throws while loading when its platform package is missing or the wrong
// architecture. That would stop the whole desktop engine from starting instead of only failing terminals.
const load = createRequire(import.meta.url)

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const pty: typeof import("@lydell/node-pty") = load("@lydell/node-pty")
  const proc = pty.spawn(file, args, opts)
  return {
    pid: proc.pid,
    onData(listener) {
      return proc.onData(listener)
    },
    onExit(listener) {
      return proc.onExit(listener)
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      proc.kill(signal)
    },
  }
}
