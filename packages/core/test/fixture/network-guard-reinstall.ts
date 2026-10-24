// network-guard.test.ts runs this in a process of its own, whose proxy variables start unset as at the start of a test
// run: one file's strict guard comes and goes, then the next file's guard sends Bun.fetch to an outside address.
import { EgressGuard } from "../../src/local-mode/guard"
import { NetworkGuard } from "../lib/network-guard"

NetworkGuard.strict().uninstall()
const handle = EgressGuard.installStrict()
const outcome = await Bun.fetch("http://198.51.100.7/", { signal: AbortSignal.timeout(3_000) }).then(
  (response) => String(response.status),
  (error) => (error instanceof Error ? error.name : String(error)),
)
handle.uninstall()
console.log(outcome)
