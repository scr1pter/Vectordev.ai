// Actual CLI and both HTTP engine runtimes; all accounts, keys, policies and TLS endpoints are synthetic.
import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.homedir(), ".cache/vector-teams-fixture-"))
const project = path.join(home, "project")
const stateFile = path.join(home, "data/vector/teams.json")
const account = { id: "11111111-1111-4111-8111-111111111111", email: "teams@example.invalid" }
const alpha = "22222222-2222-4222-8222-222222222222"
const beta = "33333333-3333-4333-8333-333333333333"
const token = "vct_vector_synthetic_teams_fixture"
const keys = generateKeyPairSync("ed25519")
const certificate = path.join(home, "certificate.pem")
const key = path.join(home, "key.pem")
const requests: string[] = []
const denied: string[] = []
const evidence: Record<string, unknown> = {}
const logs: { args: string[]; code: number; stdout: string; stderr: string }[] = []
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
await mkdir(project)
const openssl = Bun.spawn(
  [
    "openssl",
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
    "/CN=Vector synthetic Teams",
    "-addext",
    "subjectAltName=DNS:vectordev.ai",
  ],
  { stdout: "ignore", stderr: "ignore" },
)
assert.equal(await openssl.exited, 0)
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url)
    requests.push(url.pathname + url.search)
    if (url.pathname === "/api/account/cli-verify") {
      assert.deepEqual(await request.json(), { token })
      return Response.json({ ok: true, user: account })
    }
    if (url.pathname === "/api/org/keys")
      return Response.json({
        keys: [
          { id: "fixture", publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url") },
        ],
      })
    if (url.pathname === "/api/free-models/models")
      return Response.json({ enabled: false, updatedAt: Date.now(), models: [] })
    if (url.pathname === "/api/org/config") {
      assert.equal(request.headers.get("authorization"), `Bearer ${token}`)
      const selected = url.searchParams.get("org")
      if (selected && ![alpha, beta].includes(selected)) return new Response(null, { status: 403 })
      const name = selected === alpha ? "Alpha" : "Beta"
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          issuer: "https://vectordev.ai",
          audience: "vector-teams",
          account,
          credentialHash: createHash("sha256").update(token).digest("hex"),
          issuedAt: Date.now(),
          expiresAt: Date.now() + 600_000,
          orgs: [
            { id: alpha, name: "Alpha", role: "member" },
            { id: beta, name: "Beta", role: "member" },
          ],
          active: selected
            ? {
                id: selected,
                revision: 1,
                config: {
                  username: `Team ${name}`,
                  permission: { read: "allow", edit: "deny" },
                  agent: {
                    "team-marker": {
                      description: `Signed ${name}`,
                      prompt: "Synthetic team fixture instructions",
                      mode: "all",
                    },
                  },
                },
              }
            : null,
        }),
      ).toString("base64url")
      return Response.json({
        version: 1,
        keyId: "fixture",
        payload,
        signature: sign(null, Buffer.from(`vector-org-config-v1.${payload}`), keys.privateKey).toString("base64url"),
      })
    }
    denied.push(url.href)
    return new Response("Unexpected fixture endpoint", { status: 403 })
  },
})
const proxy = createServer((_request, response) => response.writeHead(403).end())
proxy.on("connect", (request, client, head) => {
  if (request.url !== "vectordev.ai:443") {
    denied.push(request.url ?? "")
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
    return
  }
  const socket = connect(upstream.port!, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) socket.write(head)
    client.pipe(socket)
    socket.pipe(client)
  })
  socket.on("error", () => client.destroy())
  client.on("error", () => socket.destroy())
})
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
const address = proxy.address()
assert(address && typeof address !== "string")
const proxyURL = `http://127.0.0.1:${address.port}`
const invocation = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [process.execPath, "run", "--conditions=browser", path.resolve(import.meta.dir, "../src/index.ts")]
const env = {
  HOME: home,
  PATH: process.env.PATH!,
  VECTOR_TEST_HOME: home,
  VECTOR_CLI: "1",
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  VECTOR_DISABLE_AUTOUPDATE: "1",
  VECTOR_DISABLE_LSP_DOWNLOAD: "1",
  VECTOR_DISABLE_CHANNEL_DB: "1",
  VECTOR_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json"),
  HTTPS_PROXY: proxyURL,
  HTTP_PROXY: proxyURL,
  https_proxy: proxyURL,
  http_proxy: proxyURL,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  NODE_EXTRA_CA_CERTS: certificate,
}
async function run(args: string[], success = true) {
  const child = Bun.spawn([...invocation, ...args], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  const timeout = setTimeout(() => child.kill("SIGKILL"), 40_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout))
  assert(!stdout.includes(token) && !stderr.includes(token), "Synthetic token leaked into CLI output")
  logs.push({ args: args.map((value) => (value === token ? "<synthetic-token>" : value)), code, stdout, stderr })
  if (success) assert.equal(code, 0, stderr + stdout)
  else assert.notEqual(code, 0, stderr + stdout)
  return { stdout, stderr }
}
async function projectConfig(valid = true) {
  await Bun.write(
    path.join(project, "vector.json"),
    valid ? JSON.stringify({ lsp: false, formatter: false, snapshot: false, permission: { read: "deny" } }) : "{broken",
  )
}
try {
  await Bun.write(stateFile, "{corrupt")
  await projectConfig(false)
  await run(["org", "personal"])
  assert.equal(await Bun.file(stateFile).exists(), false)
  await run(["org", "list"])
  assert.equal(requests.length, 0, "Personal repair/no-account list must not contact hosted services")
  evidence.offlineRepairWithoutBootstrap = true
  await projectConfig()
  await run(["login", "--token", token])
  assert(requests.includes("/api/org/config"), "Login should discover verified memberships")
  await run(["org", "switch", alpha])
  assert.equal((await Bun.file(stateFile).json()).selected, alpha)
  assert(!(await Bun.file(stateFile).text()).includes(token))
  evidence.loginAndCliSwitch = true

  const server = Bun.spawn([...invocation, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(server)
  const lines: string[] = []
  const stderr = new Response(server.stderr).text()
  const reader = server.stdout.getReader()
  const ready = Promise.withResolvers<string>()
  const collect = (async () => {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      lines.push(new TextDecoder().decode(chunk.value))
      const match = lines.join("").match(/vector server listening on (http:\/\/127\.0\.0\.1:\d+)/)
      if (match) ready.resolve(match[1])
    }
  })()
  const timer = setTimeout(() => ready.reject(new Error("Server did not start")), 30_000)
  const base = await ready.promise.finally(() => clearTimeout(timer))
  const request = async (route: string, body?: unknown, expected = 200) => {
    const response = await fetch(base + route, {
      headers: { "content-type": "application/json", "x-vector-directory": project },
      ...(body !== undefined ? { method: "POST", body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    })
    const result: unknown = await response.json()
    assert.equal(response.status, expected, JSON.stringify(result))
    return result
  }
  const legacy = async (name?: string) => {
    const value = (await request("/config")) as {
      username?: string
      permission?: unknown
      agent?: Record<string, unknown>
    }
    if (name) assert.equal(value.username, `Team ${name}`)
    else assert(!value.agent?.["team-marker"])
    assert.deepEqual(value.permission, name ? { read: "deny", edit: "deny" } : { read: "deny" })
  }
  const native = async (name?: string) => {
    const deadline = Date.now() + 10_000
    for (;;) {
      const value = (await request(`/api/agent?location[directory]=${encodeURIComponent(project)}`)) as {
        data: { id: string; description?: string }[]
      }
      const description = value.data.find((agent) => agent.id === "team-marker")?.description
      if (value.data.some((agent) => agent.id === "build") && description === (name ? `Signed ${name}` : undefined))
        return
      assert(
        Date.now() < deadline,
        `Native agent configuration did not refresh: ${JSON.stringify(value.data.map((agent) => ({ id: agent.id, description: agent.description })))}`,
      )
      await Bun.sleep(25)
    }
  }
  await legacy("Alpha")
  await native("Alpha")
  const list = (await request("/experimental/console/orgs")) as {
    enabled: boolean
    orgs: { active: boolean; orgID: string }[]
  }
  assert.equal(list.enabled, true)
  assert.equal(list.orgs.find((org) => org.active)?.orgID, alpha)
  await request("/experimental/console/switch", { orgID: beta }, 400)
  await request("/experimental/console/switch", { orgID: beta, accountID: beta }, 400)
  assert.equal((await Bun.file(stateFile).json()).selected, alpha)
  await request("/experimental/console/switch", { orgID: beta, accountID: account.id })
  await legacy("Beta")
  await native("Beta")
  evidence.cumulativeV1V2SwitchAndAccountFence = true

  await Bun.write(stateFile, "{corrupt")
  await projectConfig(false)
  await request("/experimental/console/orgs", undefined, 400)
  await request("/experimental/console/switch", { orgID: null })
  assert.equal(await Bun.file(stateFile).exists(), false)
  await projectConfig()
  await legacy()
  await native()
  evidence.httpRecoveryAndNativeCacheInvalidation = true

  await run(["org", "switch", alpha])
  await request("/global/dispose", {})
  await legacy("Alpha")
  await native("Alpha")
  await run(["logout"])
  assert.equal(await Bun.file(stateFile).exists(), false)
  await request("/global/dispose", {})
  await legacy()
  await native()
  evidence.logoutAndRunningServerRefresh = true
  server.kill("SIGTERM")
  await server.exited
  await collect
  const serverError = await stderr
  assert(!lines.join("").includes(token) && !serverError.includes(token))
  assert.deepEqual(denied, [])
  evidence.successful = true
} finally {
  for (const child of children) child.kill("SIGKILL")
  upstream.stop(true)
  proxy.closeAllConnections()
  proxy.close()
  await Bun.write(path.join(home, "result.json"), JSON.stringify({ evidence, requests, denied, logs }, null, 2))
  console.log(`Teams acceptance evidence: ${path.join(home, "result.json")}`)
  if (evidence.successful && process.env.VECTOR_KEEP_FIXTURE !== "1") await rm(home, { recursive: true, force: true })
}
