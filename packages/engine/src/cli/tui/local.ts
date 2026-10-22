export * as TuiLocal from "./local"

import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { Config } from "@/config/config"

// The terminal UI decides Vector Local on two threads. The engine thread's Config layer watches the files Vector
// Local reads; the main thread renders and starts the Workers OpenTUI uses, which follow its guard (its syntax
// highlighting downloads grammars from github.com in one). So the main thread watches the same files, and a switch
// made while the terminal UI runs reaches its guard and those Workers too. What it decides goes to the engine thread,
// whose log is the one "What Vector sent" reads.

/**
 * Keeps this thread's Vector Local policy current and sends each event it records, starting with those in memory, to
 * `send`. Returns the function that stops both.
 */
export function share(send: (event: LocalMode.Event) => void) {
  const stop = Config.watchLocal()
  Egress.events().forEach(send)
  const unsubscribe = Egress.subscribe(send)
  return () => {
    unsubscribe()
    stop()
  }
}
