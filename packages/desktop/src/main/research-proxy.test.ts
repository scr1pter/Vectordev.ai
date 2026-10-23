import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { LookupAddress } from "node:dns"
import net from "node:net"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressProxy } from "@vectordevai/core/local-mode/egress-proxy"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { USER, startResearchProxy, useResearchNetwork, type ResearchProxy } from "./research-proxy"

// The research browsers' proxy as desktop main starts it, against the fake web and the strict network guard: clients
// here write raw requests to it, as Chromium does. No name reaches DNS; the resolver is the test's.

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    ...FakeWeb.sites(),
    // A site that answers as a proxy asking for credentials would.
    asking: { "/": { status: 407, headers: { "proxy-authenticate": 'Basic realm="site"' }, body: "credentials" } },
    hopping: {
      "/robots.txt": FakeWeb.redirect(302, (at) => at.url("article", "/robots.txt")),
    },
  },
})

// A public address no test reaches: the strict guard refuses any connection to it before it is made.
const PUBLIC = "93.184.216.34"
const ADDRESSES: Record<string, readonly string[]> = {
  "loop.example": ["127.0.0.1"],
  "zero.example": ["0.0.0.0"],
  "lan.example": ["192.168.1.20"],
  "ten.example": ["10.0.0.5"],
  "cgnat.example": ["100.100.100.200"],
  "metadata.example": ["169.254.169.254"],
  "ula.example": ["fd00:ec2::254"],
  "mapped.example": ["::ffff:127.0.0.1"],
  // NAT64 and 6to4 forms of loopback and the user's network.
  "nat64.example": ["64:ff9b::7f00:1"],
  "nat64-lan.example": ["64:ff9b::a00:5"],
  "sixtofour.example": ["2002:7f00:1::1"],
  "sixtofour-lan.example": ["2002:a00:5::1"],
  // One public answer does not make a private one safe.
  "mixed.example": [PUBLIC, "10.0.0.1"],
}
const lookups: string[] = []
const flips = { count: 0 }
const resolver = (hostname: string): Promise<readonly LookupAddress[]> => {
  lookups.push(hostname)
  if (LocalPolicy.domainMatches(hostname, FakeWeb.DOMAIN)) return web.resolver(hostname)
  // Public at the first lookup, this computer at the next, as a rebinding name answers.
  if (hostname === "flip.example") {
    flips.count++
    return Promise.resolve([{ address: flips.count === 1 ? PUBLIC : "127.0.0.1", family: 4 }])
  }
  const found = ADDRESSES[hostname]
  if (!found) return Promise.reject(new Error(`No test address for ${hostname}`))
  return Promise.resolve(found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))
}
useResearchNetwork({ resolver, privateHosts: [FakeWeb.DOMAIN] })

afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await Egress.erase()
})
afterAll(async () => {
  useResearchNetwork({})
  await web.close()
})

// The credentials a research browser's `login` gives its own proxy.
const credentials = (proxy: ResearchProxy) => {
  const given: { user?: string; password?: string } = {}
  proxy.login({ isProxy: true, host: "127.0.0.1", port: proxy.port }, (user, password) =>
    Object.assign(given, { user, password }),
  )
  return `Proxy-Authorization: Basic ${Buffer.from(`${given.user}:${given.password}`).toString("base64")}`
}

const send = (port: number, text: string) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text))
    const done = () => resolve(Buffer.concat(chunks).toString())
    socket.on("data", (chunk: Buffer) => chunks.push(chunk))
    socket.on("end", done)
    socket.on("error", reject)
    setTimeout(() => {
      socket.destroy()
      done()
    }, 1_500)
  })
const get = (port: number, url: string, auth?: string) =>
  send(port, `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${auth ? `${auth}\r\n` : ""}\r\n`)
const status = (reply: string) => reply.split("\r\n")[0]

const started: ResearchProxy[] = []
const start = async () => {
  const proxy = await startResearchProxy({ attribution: { sessionID: "ses_researcher", rootID: "ses_lead" } })
  started.push(proxy)
  return proxy
}
afterAll(() => Promise.all(started.map((proxy) => proxy.stop())))

describe("research proxy", () => {
  test("answers its own challenge with a long per-browser secret and cancels every other challenge", async () => {
    const proxy = await start()
    const other = await start()
    const answers: unknown[][] = []
    const login = (target: ResearchProxy, info: { isProxy: boolean; host: string; port: number }) =>
      target.login(info, (...given) => answers.push(given))
    login(proxy, { isProxy: true, host: "127.0.0.1", port: proxy.port })
    // A site's own Basic, NTLM or Negotiate challenge, and another proxy's, get no credentials.
    login(proxy, { isProxy: false, host: "journal.example", port: 443 })
    login(proxy, { isProxy: true, host: "proxy.corp.example", port: 8080 })
    login(proxy, { isProxy: true, host: "127.0.0.1", port: other.port })
    expect(answers[0]![0]).toBe(USER)
    expect(String(answers[0]![1])).toMatch(/^[0-9a-f]{64}$/)
    expect(answers.slice(1)).toEqual([[], [], []])
    // Each browser's proxy has its own secret.
    const secrets = [proxy, other].map((item) => credentials(item))
    expect(secrets[0]).not.toBe(secrets[1])
  })

  test("points a session at itself for every host, loopback included, with no direct fallback", async () => {
    const proxy = await start()
    const configs: Electron.ProxyConfig[] = []
    await proxy.apply({ setProxy: async (config) => void configs.push(config) })
    expect(configs).toEqual([
      { mode: "fixed_servers", proxyRules: `http://127.0.0.1:${proxy.port}`, proxyBypassRules: "<-loopback>" },
    ])
  })

  test("a client without the secret gets 407, and the secret is never passed on", async () => {
    const proxy = await start()
    const page = web.url("article", "/")
    expect(status(await get(proxy.port, page))).toBe("HTTP/1.1 407 Proxy Authentication Required")
    const wrong = `Proxy-Authorization: Basic ${Buffer.from(`${USER}:${"0".repeat(64)}`).toString("base64")}`
    expect(status(await get(proxy.port, page, wrong))).toBe("HTTP/1.1 407 Proxy Authentication Required")
    // Another browser's secret is not this one's.
    expect(status(await get(proxy.port, page, credentials(await start())))).toBe(
      "HTTP/1.1 407 Proxy Authentication Required",
    )
    expect(web.count("article", "/")).toBe(0)
    const reply = await get(proxy.port, page, credentials(proxy))
    expect(status(reply)).toBe("HTTP/1.1 200 OK")
    const hit = web.hits().findLast((item) => item.site === "article")!
    expect(Object.keys(hit.headers).filter((name) => name.startsWith("proxy-"))).toEqual([])
    // A site that asks for proxy credentials is answered 502, so the browser is never asked for the secret again.
    const asking = await get(proxy.port, web.url("asking", "/"), credentials(proxy))
    expect(status(asking)).toBe("HTTP/1.1 502 Bad Gateway")
    expect(asking).not.toContain("Proxy-Authenticate")
  })

  for (const local of [false, true])
    test(`refuses loopback, 0.0.0.0, private, NAT64, 6to4 and metadata addresses after resolving, Local ${local ? "on" : "off"}`, async () => {
      if (local) Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
      const proxy = await start()
      const auth = credentials(proxy)
      const before = guard.attempts().length
      for (const name of Object.keys(ADDRESSES)) {
        const reply = await get(proxy.port, `http://${name}/`, auth)
        expect({ name, reply: status(reply) }).toEqual({ name, reply: "HTTP/1.1 403 Forbidden" })
        expect(reply).toContain(EgressProxy.PRIVATE_REASON)
        const tunnel = await send(proxy.port, `CONNECT ${name}:443 HTTP/1.1\r\nHost: ${name}:443\r\n${auth}\r\n\r\n`)
        expect({ name, tunnel: status(tunnel) }).toEqual({ name, tunnel: "HTTP/1.1 403 Forbidden" })
      }
      // Nothing was connected to: the only connections were to the proxy.
      const reached = new Set(
        guard
          .attempts()
          .slice(before)
          .map((attempt) => `${attempt.host}:${attempt.port}`),
      )
      expect([...reached]).toEqual([`127.0.0.1:${proxy.port}`])
      // Under Vector Local, each refusal is in the network log as research-browser's.
      expect(new Set(Egress.events().map((event) => [event.source, event.rule].join(" ")))).toEqual(
        local ? new Set(["research-browser private-destination"]) : new Set(),
      )
    })

  test("a name whose answer flips between lookups never reaches this computer", async () => {
    const proxy = await start()
    const auth = credentials(proxy)
    const before = guard.attempts().length
    lookups.length = 0
    // The first answer is public: the proxy connects to that address, the one it checked, and to nothing else. The
    // strict guard stops even that connection before it is made.
    expect(status(await get(proxy.port, "http://flip.example/", auth))).toBe("HTTP/1.1 403 Forbidden")
    // The next answer is this computer: refused after resolving, as any private answer is.
    const second = await get(proxy.port, "http://flip.example/next", auth)
    expect(status(second)).toBe("HTTP/1.1 403 Forbidden")
    expect(second).toContain(EgressProxy.PRIVATE_REASON)
    expect(lookups).toEqual(["flip.example", "flip.example"])
    const reached = guard
      .attempts()
      .slice(before)
      .map((attempt) => `${attempt.host}:${attempt.port}`)
      .filter((target) => target !== `127.0.0.1:${proxy.port}`)
    expect(reached).toEqual([`${PUBLIC}:80`])
    expect(web.hits().filter((hit) => hit.host.startsWith("flip"))).toEqual([])
  })

  test("fetches robots.txt through itself, following redirects on the same host only", async () => {
    const proxy = await start()
    const before = web.count("docs", "/robots.txt")
    const robots = await proxy.robots(web.url("docs", "/robots.txt"))
    expect(robots).toMatchObject({ status: 200 })
    expect(robots.status === 200 && robots.text).toContain("User-agent")
    expect(web.count("docs", "/robots.txt") - before).toBe(1)
    // The request went through the proxy: its secret was checked and not passed on.
    const hit = web.hits().findLast((item) => item.site === "docs")!
    expect(Object.keys(hit.headers).filter((name) => name.startsWith("proxy-"))).toEqual([])
    // A redirect to another host is not followed.
    expect(await proxy.robots(web.url("hopping", "/robots.txt"))).toEqual({ status: "unreachable" })
    expect(web.count("article", "/robots.txt")).toBe(0)
  })
})
