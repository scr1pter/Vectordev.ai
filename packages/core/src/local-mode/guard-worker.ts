import { EgressGuard } from "./guard"

// What the egress guard preloads in every Worker it sees started, under Bun, so the worker's own fetches and sockets
// are decided as its parent's are. In strict mode (a test) the worker's HTTP already reaches the parent's guard proxy
// through the proxy environment it shares, so it starts no proxy of its own. Under Vector Local it follows the policy
// of the thread that started it, and reports what it decides back there; started by a sealed thread, it is sealed.
const test = EgressGuard.testEnvironment()
if (test.strict) EgressGuard.installStrict({ names: test.names, proxy: false, parentProxy: test.proxy })
else EgressGuard.follow()
