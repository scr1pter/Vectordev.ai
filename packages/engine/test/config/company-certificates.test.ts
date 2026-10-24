import { afterAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalCA } from "@vectordevai/core/local-mode/ca"
import { NetworkGuard } from "../../../core/test/lib/network-guard"

// The terminal's Vector runs on Bun, which cannot add a company's certificate authority to what every connection
// trusts, so each request through Egress.fetch (every labelled request, and every model call the provider makes) carries
// it. The company's policy names the file; the server is on 127.0.0.1 with a certificate made for the test.

const guard = NetworkGuard.use()
const managedDirectory = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR!
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

  // Read once, at the first request that asks.
  expect(LocalCA.company().added).toHaveLength(1)
  expect(await (await Egress.fetch("local-inference", url)).text()).toBe("company")
})
