import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { LookupAddress } from "node:dns"
import net from "node:net"
import { Egress } from "../../src/local-mode/egress"
import { EgressProxy } from "../../src/local-mode/egress-proxy"
import { LocalPolicy } from "../../src/local-mode/policy"
import { FakeWeb } from "../lib/fake-web"
import { NetworkGuard } from "../lib/network-guard"

// The research browsers' proxy. Its clients here write raw requests to it, as a browser does, since the strict guard
// refuses a fetch that names a proxy of its own. The resolver is the test's: no name reaches DNS.

const guard = NetworkGuard.use()
const web = FakeWeb.start({
  sites: {
    article: { "/": { body: "article" }, "/next": { body: "next" } },
    // A site that answers as a proxy asking for credentials would.
    asking: { "/": { status: 407, headers: { "proxy-authenticate": 'Basic realm="site"' }, body: "credentials" } },
  },
})
const SECRET = "research-proxy-secret-for-tests"
const credentials = (secret: string) =>
  `Proxy-Authorization: Basic ${Buffer.from(`vector:${secret}`).toString("base64")}`
const AUTH = credentials(SECRET)
afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await Egress.erase()
})
afterAll(() => web.close())

const ADDRESSES: Record<string, readonly string[]> = {
  "loop.example": ["127.0.0.1"],
  "lan.example": ["192.168.1.20"],
  "metadata.example": ["169.254.169.254"],
  "cgnat.example": ["100.100.100.200"],
  "ula.example": ["fd00:ec2::254"],
  "mapped.example": ["::ffff:10.0.0.1"],
  "zero.example": ["0.0.0.0"],
  "app.localhost": ["127.0.0.1"],
  // One public answer does not make a private one safe.
  "mixed.example": ["203.0.113.80", "10.0.0.1"],
}
const asked: string[] = []
const resolver = (hostname: string): Promise<readonly LookupAddress[]> => {
  asked.push(hostname)
  if (LocalPolicy.domainMatches(hostname, FakeWeb.DOMAIN)) return web.resolver(hostname)
  const found = ADDRESSES[hostname]
  if (!found) return Promise.reject(new Error(`No test address for ${hostname}`))
  return Promise.resolve(found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })))
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
const get = (port: number, url: string, auth = AUTH) =>
  send(port, `GET ${url} HTTP/1.1\r\nHost: ${new URL(url).host}\r\n${auth ? `${auth}\r\n` : ""}\r\n`)

describe("EgressProxy", () => {
  test("reaches a site at the address it resolved, once, and logs it as research-browser under Vector Local", async () => {
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    const proxy = await EgressProxy.start({
      secret: SECRET,
      resolver,
      privateHosts: [FakeWeb.DOMAIN],
      attribution: { sessionID: "ses_researcher", rootID: "ses_lead", agent: "researcher" },
    })
    try {
      asked.length = 0
      const page = await get(proxy.port, web.url("article", "/"))
      expect(page).toStartWith("HTTP/1.1 200")
      expect(page).toEndWith("article")
      // A tunnel carries the browser's own bytes; this one is plain http inside it.
      const host = new URL(web.url("article", "/")).host
      const tunnel = await send(
        proxy.port,
        `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${AUTH}\r\n\r\nGET /next HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      )
      expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established")
      expect(tunnel).toEndWith("next")
      expect(asked).toEqual(["article.web.test", "article.web.test"])
      expect(web.hits().map((hit) => [hit.host.replace(/:\d+$/, ""), hit.path])).toEqual([
        ["article.web.test", "/"],
        ["article.web.test", "/next"],
      ])
      expect(Egress.events().map((event) => [event.source, event.purpose, event.method, event.decision])).toEqual([
        ["research-browser", "research-browser", "GET", "allow"],
        ["research-browser", "research-browser", "CONNECT", "allow"],
      ])
      expect(Egress.events()[0]).toMatchObject({ session_id: "ses_researcher", root_session_id: "ses_lead" })
    } finally {
      await proxy.stop()
    }
  })

  for (const local of [false, true])
    test(`refuses loopback, private, link-local, CGNAT, ULA and metadata addresses after resolving, Local ${local ? "on" : "off"}`, async () => {
      if (local) Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
      const proxy = await EgressProxy.start({ secret: SECRET, resolver })
      const before = guard.attempts().length
      try {
        for (const name of Object.keys(ADDRESSES)) {
          const reply = await get(proxy.port, `http://${name}/`)
          expect({ name, reply: reply.split("\r\n")[0] }).toEqual({ name, reply: "HTTP/1.1 403 Forbidden" })
          expect(reply).toContain(EgressProxy.PRIVATE_REASON)
          const tunnel = await send(proxy.port, `CONNECT ${name}:443 HTTP/1.1\r\nHost: ${name}:443\r\n${AUTH}\r\n\r\n`)
          expect({ name, tunnel: tunnel.split("\r\n")[0] }).toEqual({ name, tunnel: "HTTP/1.1 403 Forbidden" })
        }
        // Addresses written out are refused without a lookup.
        for (const target of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://[::1]:8080/"])
          expect((await get(proxy.port, target)).split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden")
        // Nothing was connected to: the only attempts are the clients reaching the proxy.
        const reached = new Set(
          guard
            .attempts()
            .slice(before)
            .map((attempt) => `${attempt.host}:${attempt.port}`),
        )
        expect([...reached]).toEqual([`127.0.0.1:${proxy.port}`])
        expect(Egress.events().map((event) => event.rule)).toEqual(
          local ? Array.from({ length: Object.keys(ADDRESSES).length * 2 + 3 }, () => "private-destination") : [],
        )
      } finally {
        await proxy.stop()
      }
    })

  test("refuses a name its own name places on this computer or your network, before any lookup", async () => {
    const proxy = await EgressProxy.start({ secret: SECRET, resolver })
    try {
      asked.length = 0
      for (const name of ["localhost", "app.localhost", "printer.local", "intranet", "nas.home.arpa"])
        expect((await get(proxy.port, `http://${name}/`)).split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden")
      // `app.localhost` is not this computer by its name alone, so it is looked up, and refused at 127.0.0.1.
      expect(asked).toEqual(["app.localhost"])
    } finally {
      await proxy.stop()
    }
  })

  test("follows Web access under Vector Local, deciding before any lookup", async () => {
    const proxy = await EgressProxy.start({ secret: SECRET, resolver, privateHosts: [FakeWeb.DOMAIN] })
    const before = web.count("article")
    try {
      asked.length = 0
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))
      const none = await get(proxy.port, web.url("article", "/"))
      expect(none.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden")
      expect(none).toContain("Web access is set to None")
      Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web_domains: { deny: ["article.web.test"] } } }))
      expect(await get(proxy.port, web.url("article", "/"))).toContain("never reaches")
      expect(asked).toEqual([])
      expect(web.count("article")).toBe(before)
      expect(Egress.events().map((event) => [event.decision, event.rule])).toEqual([
        ["block", "web-none"],
        ["block", "web-deny"],
      ])
    } finally {
      await proxy.stop()
    }
  })

  test("asks the run's own limits before each request", async () => {
    const seen: string[] = []
    const proxy = await EgressProxy.start({
      secret: SECRET,
      resolver,
      privateHosts: [FakeWeb.DOMAIN],
      admit: (destination) => {
        seen.push(destination.host)
        return { status: 429, reason: "Too Many Requests", message: "This site's page limit for the run is used." }
      },
    })
    const before = web.count("article")
    try {
      const reply = await get(proxy.port, web.url("article", "/"))
      expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 429 Too Many Requests")
      expect(seen).toEqual(["article.web.test"])
      expect(web.count("article")).toBe(before)
    } finally {
      await proxy.stop()
    }
  })

  test("answers a request it cannot read with 400, and a name it cannot find with 502", async () => {
    const proxy = await EgressProxy.start({ secret: SECRET, resolver })
    try {
      expect((await send(proxy.port, `GET /relative HTTP/1.1\r\nHost: x\r\n${AUTH}\r\n\r\n`)).split("\r\n")[0]).toBe(
        "HTTP/1.1 400 Bad Request",
      )
      expect((await get(proxy.port, "http://missing.example/")).split("\r\n")[0]).toBe("HTTP/1.1 502 Bad Gateway")
    } finally {
      await proxy.stop()
    }
  })

  test("answers 407 to a request without its secret, or with another, before deciding anything", async () => {
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    const proxy = await EgressProxy.start({ secret: SECRET, resolver, privateHosts: [FakeWeb.DOMAIN] })
    const before = web.count("article")
    try {
      asked.length = 0
      const host = new URL(web.url("article", "/")).host
      const replies = [
        await get(proxy.port, web.url("article", "/"), ""),
        await get(proxy.port, web.url("article", "/"), credentials("another-secret-of-this-size")),
        await get(proxy.port, web.url("article", "/"), `Proxy-Authorization: Bearer ${SECRET}`),
        await send(proxy.port, `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
      ]
      for (const reply of replies) {
        expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 407 Proxy Authentication Required")
        expect(reply).toContain('Proxy-Authenticate: Basic realm="Vector"')
      }
      // Nothing was decided, looked up, logged or reached.
      expect(asked).toEqual([])
      expect(Egress.events()).toEqual([])
      expect(web.count("article")).toBe(before)
    } finally {
      await proxy.stop()
    }
  })

  test("never passes its secret on, and answers a site's own 407 as 502", async () => {
    const proxy = await EgressProxy.start({ secret: SECRET, resolver, privateHosts: [FakeWeb.DOMAIN] })
    try {
      expect(await get(proxy.port, web.url("article", "/"))).toEndWith("article")
      const hit = web.hits().at(-1)!
      expect(Object.keys(hit.headers).filter((name) => name.toLowerCase().startsWith("proxy-"))).toEqual([])
      expect(JSON.stringify(hit.headers)).not.toContain(Buffer.from(`vector:${SECRET}`).toString("base64"))
      const asking = await get(proxy.port, web.url("asking", "/"))
      expect(asking.split("\r\n")[0]).toBe("HTTP/1.1 502 Bad Gateway")
      expect(asking).not.toContain("Proxy-Authenticate")
      expect(web.count("asking")).toBe(1)
    } finally {
      await proxy.stop()
    }
  })

  test("refuses to start without a long secret", async () => {
    await expect(EgressProxy.start({ secret: "short" })).rejects.toThrow("long random secret")
  })
})
