import { randomBytes } from "node:crypto"
import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import type { EgressAttribution } from "@vectordevai/core/local-mode/attribution"
import { EgressProxy } from "@vectordevai/core/local-mode/egress-proxy"
import type { ForwardProxy } from "@vectordevai/core/local-mode/forward-proxy"
import { ResearchRobots } from "@vectordevai/core/research/robots"
import type { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"

// The research browsers' network guard in desktop main (section 5.6a). The proxy itself is core's EgressProxy (L4):
// a forward proxy on 127.0.0.1 that needs a secret, resolves each name once, refuses loopback, private, link-local,
// CGNAT, ULA, NAT64 and 6to4 forms of those and cloud metadata addresses after resolving, refuses an answer that mixes
// public and private addresses, reaches web ports only, connects to the address it checked, never passes its secret
// on and answers a site's 407 as 502. Under Vector Local it decides each destination as `research-browser` and logs it.
//
// This file wires one proxy to each research browser while it is open: a secret of its own, the agent it works for as
// attribution, the slot session pointed at it with Chromium's implicit loopback bypass removed (`<-loopback>`, without
// which a hostile page could reach Vector's engine, the browser bridge or a dev server directly), and Electron's
// `login` answered for this proxy alone. robots.txt for links the browser discovers is fetched through it too. Nothing
// here edits desktop main's index.ts: a proxy starts with the browser that needs it.

export const NEEDS_GUARD = "Research browsers need Vector's network guard, which could not start."
/** The user name a research browser gives its proxy; only the password (the secret) is checked. */
export const USER = "vector-research"
const FETCH_TIMEOUT = 20_000
const MAX_REDIRECTS = 3

export type ProxyAuthInfo = { readonly isProxy: boolean; readonly host: string; readonly port: number }

/** What a session needs to be pointed at a proxy: Electron's Session has it. */
export type ProxySession = { readonly setProxy: (config: Electron.ProxyConfig) => Promise<void> }

export type ResearchProxy = {
  readonly url: string
  readonly port: number
  /** Points a session at this proxy for every scheme and every host, loopback included, with no direct fallback. */
  readonly apply: (session: ProxySession) => Promise<void>
  /**
   * Answers an authentication challenge: this proxy's own with its secret; every other one (a site's Basic, NTLM or
   * Negotiate, or another proxy's) is cancelled, so no credential of the user's goes out.
   */
  readonly login: (authInfo: ProxyAuthInfo, callback: (username?: string, password?: string) => void) => void
  /** Fetches a robots.txt through this proxy, as robots.ts's cache asks for one. */
  readonly robots: (url: string) => Promise<ResearchRobots.Fetched>
  /**
   * Fetches one address through this proxy, up to `maxBytes`, following no redirect: a PDF a research browser opened,
   * which goes to the reader in memory since downloads are off.
   */
  readonly get: (url: string, maxBytes: number) => Promise<Fetched>
  readonly stop: () => Promise<void>
}

export type Fetched = {
  readonly status: number
  readonly contentType: string
  readonly body: Buffer
  readonly location?: string
}

/**
 * The network research browsers reach. Production uses the system resolver and no test names; only tests and the
 * Electron smoke set them, to the fake web's resolver and its `web.test` domain.
 */
export type Network = {
  readonly resolver?: WebFetchRequest.DestinationResolver
  readonly privateHosts?: readonly string[]
}
const network: { current: Network } = { current: {} }

/** Tests and the Electron smoke only: the fake web's resolver and names. Production never calls it. */
export function useResearchNetwork(next: Network) {
  network.current = next
}

/** Starts a proxy for one research browser. It fails with NEEDS_GUARD when it cannot start. */
export async function startResearchProxy(input: {
  readonly attribution?: EgressAttribution.Info
  readonly admit?: (destination: ForwardProxy.Destination) => ForwardProxy.Refusal | undefined
}): Promise<ResearchProxy> {
  const secret = randomBytes(32).toString("hex")
  const proxy = await EgressProxy.start({
    secret,
    source: "research-browser",
    ...(input.attribution ? { attribution: input.attribution } : {}),
    ...(input.admit ? { admit: input.admit } : {}),
    ...(network.current.resolver ? { resolver: network.current.resolver } : {}),
    ...(network.current.privateHosts ? { privateHosts: network.current.privateHosts } : {}),
  }).catch((error: unknown) => {
    throw new Error(NEEDS_GUARD, { cause: error })
  })
  const authorization = `Basic ${Buffer.from(`${USER}:${secret}`).toString("base64")}`
  return {
    url: proxy.url,
    port: proxy.port,
    apply: (session) =>
      session.setProxy({
        mode: "fixed_servers",
        proxyRules: `http://127.0.0.1:${proxy.port}`,
        proxyBypassRules: "<-loopback>",
      }),
    login: (authInfo, callback) => {
      if (authInfo.isProxy && authInfo.host === "127.0.0.1" && authInfo.port === proxy.port)
        return callback(USER, secret)
      callback()
    },
    robots: (url) => robotsThrough(proxy.port, authorization, url),
    get: (url, maxBytes) => getThrough(proxy.port, authorization, url, maxBytes),
    stop: proxy.stop,
  }
}

// One GET through the proxy, following redirects on the same host only, as the engine's robots reader does; a redirect
// elsewhere, a failure or a timeout is "unreachable", which robots.ts reads as no path allowed for now.
async function robotsThrough(port: number, authorization: string, url: string, hops = 0): Promise<ResearchRobots.Fetched> {
  const answer = await getThrough(port, authorization, url, ResearchRobots.MAX_BYTES).catch(() => undefined)
  if (!answer) return { status: "unreachable" }
  if (answer.status < 300 || answer.status >= 400) return { status: answer.status, text: answer.body.toString("utf8") }
  const next = answer.location && URL.canParse(answer.location, url) ? new URL(answer.location, url) : undefined
  if (!next || next.hostname !== new URL(url).hostname || hops >= MAX_REDIRECTS) return { status: "unreachable" }
  return robotsThrough(port, authorization, next.toString(), hops + 1)
}

function getThrough(port: number, authorization: string, url: string, maxBytes: number) {
  const target = new URL(url)
  return new Promise<Fetched>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${target.host} took too long to answer`)), FETCH_TIMEOUT)
    const settle = (response: http.IncomingMessage) => {
      const chunks: Buffer[] = []
      const state = { bytes: 0 }
      response.on("data", (chunk: Buffer) => {
        state.bytes += chunk.length
        if (state.bytes > maxBytes) return response.destroy(new Error(`The answer is over ${maxBytes} bytes`))
        chunks.push(chunk)
      })
      response.on("error", fail)
      response.on("end", () => {
        clearTimeout(timer)
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks),
          ...(typeof response.headers.location === "string" ? { location: response.headers.location } : {}),
        })
      })
    }
    const fail = (error: unknown) => {
      clearTimeout(timer)
      reject(error)
    }
    const headers = { "user-agent": "Vector", accept: "*/*" }
    if (target.protocol === "http:") {
      http
        .get(
          {
            host: "127.0.0.1",
            port,
            path: target.toString(),
            headers: { ...headers, host: target.host, "proxy-authorization": authorization },
          },
          settle,
        )
        .on("error", fail)
      return
    }
    // https: a tunnel to the site, then the request inside it over TLS to the site's own name.
    const authority = `${target.hostname.includes(":") ? `[${target.hostname}]` : target.hostname}:${target.port || 443}`
    http
      .request({
        host: "127.0.0.1",
        port,
        method: "CONNECT",
        path: authority,
        headers: { host: authority, "proxy-authorization": authorization },
      })
      .on("connect", (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          return fail(new Error(`The research proxy answered ${response.statusCode}`))
        }
        https
          .get(
            {
              host: target.hostname,
              path: `${target.pathname}${target.search}`,
              headers: { ...headers, host: target.host },
              agent: false,
              createConnection: () => tls.connect({ socket, servername: target.hostname }),
            },
            settle,
          )
          .on("error", fail)
      })
      .on("error", fail)
      .end()
  })
}
