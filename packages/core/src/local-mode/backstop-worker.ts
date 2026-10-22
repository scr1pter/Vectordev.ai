// The first import of a worker thread that makes no connections of its own, such as the brain's background reader
// (its model files and wasm come from the thread that starts it). In a worker thread it installs the guard so that any
// connection off this computer fails, however the worker was started; the thread that starts it has its own guard.
// On the main thread, where the same module is also imported for its functions, it does nothing.
import { isMainThread } from "node:worker_threads"
import { EgressGuard } from "./guard"

if (!isMainThread && !EgressGuard.installed())
  EgressGuard.installStrict({
    names: (process.env[EgressGuard.ENVIRONMENT.names] ?? "").split(",").filter(Boolean),
    proxy: false,
    throws: process.env[EgressGuard.ENVIRONMENT.strict] === "strict",
  })
