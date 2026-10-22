import { isMainThread } from "node:worker_threads"
import { Egress } from "./egress"

// What the egress guard preloads, under Bun, in every Worker it sees started, before the worker's own code runs: the
// same guard its parent has. In strict mode (tests) that is the strict guard, whose HTTP reaches the parent's guard
// proxy through the environment it shares, so it starts no proxy of its own. Otherwise it is Vector Local's, with the
// policy and the proxy settings the parent handed it in its environment; the threads of the process keep it current
// and share one log (egress.ts), so a Worker's blocked connection is logged where the app reads it. Started by a sealed
// thread, it is sealed.
if (!isMainThread) Egress.backstop()
