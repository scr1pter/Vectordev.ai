// The first import of a worker thread that makes no connections of its own, such as the brain's background reader
// (its model files and wasm come from the thread that starts it). In a worker thread it installs the guard so that any
// connection off this computer fails, however the worker was started: in place of one the worker preload installed to
// follow the policy of the process, which may allow more (EgressGuard.unfollow). A Worker it starts is sealed too, in a
// build as well, where the test variables mean nothing. The thread that starts it has its own guard. On the main
// thread, where the same module is also imported for its functions, it does nothing. The names a strict test pins to
// this computer are read only where strict mode applies (EgressGuard.strictFromEnvironment).
import { isMainThread } from "node:worker_threads"
import { EgressGuard } from "./guard"

if (!isMainThread) {
  EgressGuard.unfollow()
  const strict = EgressGuard.strictFromEnvironment()
  if (!EgressGuard.installed())
    EgressGuard.installStrict({
      names: strict?.names ?? [],
      proxy: false,
      parentProxy: strict?.proxy,
      throws: strict !== undefined,
    })
}
