import { EgressGuard } from "./guard"

// What the strict egress guard preloads in every Worker it sees started, so the worker's own fetches and sockets are
// decided as its parent's are. The worker's HTTP already reaches the parent's guard proxy through the proxy
// environment it shares, so it starts no proxy of its own.
if (process.env[EgressGuard.ENVIRONMENT.strict] === "strict")
  EgressGuard.installStrict({
    names: (process.env[EgressGuard.ENVIRONMENT.names] ?? "").split(",").filter(Boolean),
    proxy: false,
  })
