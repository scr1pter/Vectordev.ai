export * as EgressProxy from "./egress-proxy"

import { lookup } from "node:dns/promises"
import net from "node:net"
import { WebFetchRequest } from "../util/webfetch-request"
import { EgressAttribution } from "./attribution"
import { Egress } from "./egress"
import { ForwardProxy } from "./forward-proxy"
import { LocalPolicy } from "./policy"

// Vector's loopback egress proxy, which every research browser's traffic goes through (the desktop points each
// research partition at it with `session.setProxy`). For each request a browser sends it, a CONNECT tunnel or an
// absolute http URL, the proxy:
// 1. decides it as a `research-browser` request under Vector Local, before any lookup, and logs it;
// 2. refuses a host that is on this computer or the user's network by its name or address;
// 3. resolves the name itself and refuses it when any address it gets is loopback, private, link-local, CGNAT, ULA,
//    a cloud metadata address or another address that is not public (WebFetchRequest.isPrivateAddress);
// 4. asks `admit`, such as the run's per-host rate limits;
// 5. connects to the address it checked, not the name, so a second answer from DNS (rebinding) cannot change where it
//    goes. A tunnel carries the browser's own TLS, so the site's certificate is still checked against its name.
// Steps 2 to 4 apply whether Vector Local is on or off. If the proxy cannot start, research browsers do not open.

export type Refusal = ForwardProxy.Refusal

export type Options = {
  /** The registry source the requests are logged as. */
  readonly source?: string
  /** Who the browser works for: the research agent's session, its root and the agent. */
  readonly attribution?: EgressAttribution.Info
  /** Resolves a name to its addresses. Default: the system resolver. */
  readonly resolver?: WebFetchRequest.DestinationResolver
  /** Tests only: names whose private addresses the proxy may reach, such as the fake web's `web.test`. */
  readonly privateHosts?: readonly string[]
  /** Checked before each request is made; a refusal is sent to the browser as it is. */
  readonly admit?: (destination: ForwardProxy.Destination) => Refusal | undefined | Promise<Refusal | undefined>
  /** How long connecting to a site may take. */
  readonly connectTimeout?: number
}

export const PRIVATE_REASON = "Research browsers never reach this computer, your network or a cloud metadata address."
const CONNECT_TIMEOUT = 15_000

export function start(options: Options = {}): ForwardProxy.Proxy {
  const source = options.source ?? "research-browser"
  const resolver: WebFetchRequest.DestinationResolver =
    options.resolver ?? ((hostname) => lookup(hostname, { all: true, verbatim: true }))
  const attribution = options.attribution ?? {}
  const pinned = (host: string) =>
    (options.privateHosts ?? []).some((pattern) => LocalPolicy.domainMatches(host, pattern))
  const route = async (destination: ForwardProxy.Destination): Promise<ForwardProxy.Route> => {
    const request = { source, url: destination.url, method: destination.method }
    const verdict = LocalPolicy.decide(Egress.policy(), { purpose: "research-browser", url: destination.url, source })
    if (verdict.decision !== "allow") {
      Egress.record(request, verdict)
      return ForwardProxy.FORBIDDEN(verdict.reason)
    }
    const refusePrivate = (address: string) => {
      Egress.record(request, {
        decision: "block",
        rule: "private-destination",
        class: LocalPolicy.hostClass(address),
        reason: PRIVATE_REASON,
        allowable: false,
      })
      return ForwardProxy.FORBIDDEN(PRIVATE_REASON)
    }
    const host = destination.host.replace(/^\[|\]$/g, "")
    const test = pinned(host)
    if (!test && LocalPolicy.hostClass(host) !== "internet") return refusePrivate(host)
    const addresses = net.isIP(host)
      ? [host]
      : await resolver(host).then(
          (records) => records.map((record) => record.address),
          () => [],
        )
    if (addresses.length === 0)
      return { refuse: { status: 502, reason: "Bad Gateway", message: `Could not find ${host}.` } }
    const inside = addresses.find((address) => WebFetchRequest.isPrivateAddress(address))
    if (inside && !test) return refusePrivate(inside)
    const refused = await options.admit?.(destination)
    if (refused) return { refuse: refused }
    Egress.record(request, verdict)
    const address = addresses[0]!
    return {
      connect: (connected) =>
        EgressAttribution.run(attribution, () =>
          EgressAttribution.granted(
            { source, purpose: "research-browser", grants: [{ host: address, port: destination.port }] },
            () => {
              const upstream = new net.Socket()
              upstream.setTimeout(options.connectTimeout ?? CONNECT_TIMEOUT, () =>
                upstream.destroy(new Error(`Connecting to ${host} took too long.`)),
              )
              upstream.connect(destination.port, address, () => {
                upstream.setTimeout(0)
                connected()
              })
              return upstream
            },
          ),
        ),
    }
  }
  return ForwardProxy.start((destination) => EgressAttribution.run(attribution, () => route(destination)))
}
