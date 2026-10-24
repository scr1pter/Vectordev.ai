import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The terminal's Vector runs on Bun, which cannot add a company's certificate authority to what every connection
// trusts, so each request through Egress.fetch (every labelled request, and every model call the provider makes) carries
// it. The company's policy names the file; the server is on 127.0.0.1 with a certificate made for the test. Vector reads
// the company's authorities once per process, at the first request that asks, and an earlier test file's request in
// this run would already have read them without the policy, so the request is made by a process of its own.

const guard = NetworkGuard.use()
const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
const CORE = path.join(import.meta.dir, "../../../core/src")
const cleanup: (() => Promise<void>)[] = []

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()))
  rmSync(managedDirectory, { recursive: true, force: true })
  expect(guard.outside()).toEqual([])
})

test("a request through Egress.fetch trusts the certificate authority the company's policy names", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "vector-company-ca-"))
  cleanup.push(() => rm(folder, { recursive: true, force: true }))
  const certificate = path.join(folder, "company.pem")
  const key = path.join(folder, "company-key.pem")
  const made = Bun.spawn(
    [
      Bun.which("openssl") ?? "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=Vector test company CA",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  expect(await made.exited, await new Response(made.stderr).text()).toBe(0)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: await Bun.file(certificate).text(), key: await Bun.file(key).text() },
    fetch: () => new Response("company"),
  })
  cleanup.push(() => server.stop(true))
  const url = `https://127.0.0.1:${server.port}/v1/models`

  // Only an authority an administrator's policy names counts; this one is not trusted yet.
  await expect(fetch(url)).rejects.toThrow()
  mkdirSync(managedDirectory, { recursive: true })
  writeFileSync(path.join(managedDirectory, "vector.json"), JSON.stringify({ local: { ca: { files: [certificate] } } }))

  const script = path.join(folder, "request.ts")
  await Bun.write(
    script,
    `const { ConfigManaged } = await import(${JSON.stringify(path.join(CORE, "config/managed.ts"))})
ConfigManaged.useTestDirectory(process.env.MANAGED)
const { useManagedPolicyFixture } = await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/managed-policy.ts"))})
useManagedPolicyFixture(process.env.MANAGED)
const { LocalCA } = await import(${JSON.stringify(path.join(CORE, "local-mode/ca.ts"))})
const { Egress } = await import(${JSON.stringify(path.join(CORE, "local-mode/egress.ts"))})
// Read once, at the first request that asks.
const added = LocalCA.company().added.length
console.log(JSON.stringify({ added, body: await (await Egress.fetch("local-inference", process.env.URL)).text() }))
`,
  )
  const child = Bun.spawn([process.execPath, script], {
    env: { PATH: process.env.PATH, HOME: folder, MANAGED: managedDirectory, URL: url },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ added: 1, body: "company" })
})
