import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import { LocalCA } from "../../src/local-mode/ca"
import { NetworkGuard } from "../lib/network-guard"

// A company's certificate authorities under Bun, which has no way to add to what every connection trusts: each request
// carries Bun's own certificates and the company's. The servers here are on 127.0.0.1, with a certificate made for
// the test, so nothing leaves this computer.

const guard = NetworkGuard.use()
const folder = { path: "" }
const files = { company: "", key: "", leaf: "", leafKey: "", junk: "" }
const servers: { stop: (force?: boolean) => Promise<void> }[] = []

beforeAll(async () => {
  folder.path = await mkdtemp(path.join(os.tmpdir(), "vector-local-ca-"))
  files.company = path.join(folder.path, "company.pem")
  files.key = path.join(folder.path, "company-key.pem")
  files.leaf = path.join(folder.path, "leaf.pem")
  files.leafKey = path.join(folder.path, "leaf-key.pem")
  files.junk = path.join(folder.path, "junk.pem")
  await certificate(files.company, files.key, "Vector test company CA", "critical,CA:TRUE")
  await certificate(files.leaf, files.leafKey, "Vector test leaf", "critical,CA:FALSE")
  await Bun.write(files.junk, "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n")
})

afterAll(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await rm(folder.path, { recursive: true, force: true })
  expect(guard.outside()).toEqual([])
})

// A certificate for 127.0.0.1 that signs itself, so it is its own authority when `constraints` says CA:TRUE.
async function certificate(file: string, key: string, name: string, constraints: string) {
  const openssl = Bun.which("openssl")
  expect(openssl).toBeDefined()
  const made = Bun.spawn(
    [
      openssl!,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      file,
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      `basicConstraints=${constraints}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  expect(await made.exited, await new Response(made.stderr).text()).toBe(0)
}

// An https server on 127.0.0.1 whose certificate only the company's authority vouches for.
async function companyServer() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: await Bun.file(files.company).text(), key: await Bun.file(files.key).text() },
    fetch: () => new Response("company"),
  })
  servers.push(server)
  return `https://127.0.0.1:${server.port}/`
}

describe("the Bun CA list", () => {
  test("includes the root certificates, then the company's authority", async () => {
    const list = LocalCA.authorities([files.company])
    const company = await Bun.file(files.company).text()
    expect(list.added).toEqual([company.trim()])
    expect(list.problems).toEqual([])
    // Every certificate Bun trusts by default stays, so public sites keep working.
    expect(tls.rootCertificates.every((root) => list.certificates.includes(root))).toBe(true)
    expect(list.certificates.at(-1)).toBe(company.trim())
    expect(list.certificates.length).toBeGreaterThan(tls.rootCertificates.length)
  })

  test("names what it leaves out: an unreadable file, a block that is not a certificate and a certificate that is not an authority", () => {
    const missing = path.join(folder.path, "missing.pem")
    const list = LocalCA.authorities([missing, files.junk, files.leaf])
    expect(list.added).toEqual([])
    expect(list.certificates).toEqual([])
    expect(list.problems).toEqual([
      `Vector could not read the certificate file ${missing}.`,
      `${files.junk} holds a block that is not a certificate.`,
      `${files.leaf} holds a certificate for CN=Vector test leaf, not an authority.`,
    ])
  })

  test("adds an authority named twice, or one Bun already trusts, once", () => {
    const root = path.join(folder.path, "root.pem")
    const list = LocalCA.authorities([files.company, files.company, root], (file) =>
      file === root ? tls.rootCertificates[0]! : readFileSync(file, "utf8"),
    )
    expect(list.added).toHaveLength(1)
    expect(list.certificates.filter((item) => item === tls.rootCertificates[0])).toHaveLength(1)
  })
})

describe("a request under Bun", () => {
  test("reaches a server the company's authority vouches for, which it could not reach before", async () => {
    const url = await companyServer()
    await expect(fetch(url)).rejects.toThrow()
    const init = LocalCA.request({ method: "GET" }, LocalCA.authorities([files.company]))
    expect(init.method).toBe("GET")
    expect(await (await fetch(url, init)).text()).toBe("company")
  })

  test("is unchanged without a company authority, and keeps a ca of its own", () => {
    const init = { headers: { accept: "text/plain" } }
    expect(LocalCA.request(init, LocalCA.authorities([]))).toBe(init)
    const own = { tls: { ca: ["own"], rejectUnauthorized: true } } as RequestInit
    expect(LocalCA.request(own, LocalCA.authorities([files.company]))).toBe(own)
    // Other TLS options a request names stay beside the list.
    const pinned = { tls: { rejectUnauthorized: true } } as RequestInit
    const added = LocalCA.request(pinned, LocalCA.authorities([files.company])) as { tls?: Record<string, unknown> }
    expect(added.tls?.rejectUnauthorized).toBe(true)
    expect(Array.isArray(added.tls?.ca)).toBe(true)
  })
})
