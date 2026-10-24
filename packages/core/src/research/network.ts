export * as ResearchNetwork from "./network"

import { lookup } from "node:dns/promises"
import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EgressGuard } from "../local-mode/guard"
import { LocalPolicy } from "../local-mode/policy"
import type { WebFetchRequest } from "../util/webfetch-request"

/**
 * The network research reads through, on either runner. Production resolves names with the system's resolver; tests
 * give the fake web's resolver and its domain as public names, as the reader's own tests do.
 */
export type Network = {
  readonly resolver?: WebFetchRequest.DestinationResolver
  readonly publicNames?: readonly string[]
}

export class Service extends Context.Service<Service, Network>()("@vector/ResearchNetwork") {}

export const node = makeGlobalNode({ service: Service, layer: Layer.sync(Service, pinned), deps: [] })

// A test's child process in strict mode (a source checkout only, never under Vector Local, as
// EgressGuard.strictFromEnvironment decides) reaches the names it pinned on this computer, as the strict guard does, and
// reads them as public, as the in-process tests read the fake web. Everywhere else: nothing, the system's resolver.
function pinned(): Network {
  const names = EgressGuard.strictFromEnvironment()?.names ?? []
  if (names.length === 0) return {}
  return {
    resolver: (hostname) =>
      names.some((name) => LocalPolicy.domainMatches(hostname, name))
        ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
        : lookup(hostname, { all: true, verbatim: true }),
    publicNames: names,
  }
}
