// The body of an eval worker that guard-smoke's fixtures start under Node, the way the desktop's engine starts the
// brain's background reader: its first import installs the worker's own guard. It reports what a connection off this
// computer got, then ends.
import "@vectordevai/core/local-mode/backstop-worker"
import net from "node:net"
import { parentPort } from "node:worker_threads"

// A documentation address (TEST-NET-2): never routed.
const OUTSIDE = "198.51.100.7"

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => "reached",
    (error: unknown) => (error instanceof Error ? error.name : String(error)),
  )

parentPort?.postMessage({
  // A refusal that throws where the socket is made rejects this promise too.
  net: await outcome(
    new Promise((resolve, reject) => {
      const socket = net.connect(80, OUTSIDE)
      socket.on("connect", resolve)
      socket.on("error", reject)
    }),
  ),
  fetch: await outcome(fetch(`http://${OUTSIDE}/`)),
})
