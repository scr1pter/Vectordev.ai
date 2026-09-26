// Isolated acceptance for source or compiled CLI. No production endpoint overrides or OS trust changes.
// Run from packages/engine: bun script/verify-free-models.ts [compiled-binary]
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import os from "node:os"
import path from "node:path"

const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-free-acceptance-")))
const project = path.join(home, "sample")
const modelID = "qwen/qwen3.8-27b:free"
const token = "vct_synthetic-acceptance-account"
const ownKey = "synthetic-acceptance-openrouter-key"
const password = "synthetic-acceptance-server"
const source = "export function divide(a: number, b: number) { return a / b }\n"
await Bun.write(path.join(project, "math.ts"), "export function divide(a: number, b: number) { return 0 }\n")
const git = Bun.spawn(["git", "init", "--quiet", project], {
  env: { HOME: home, PATH: "/usr/bin:/bin" },
  stdout: "ignore",
  stderr: "pipe",
})
assert.equal(await git.exited, 0, await new Response(git.stderr).text())
for (const args of [
  ["add", "math.ts"],
  [
    "-c",
    "user.name=Vector Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test: add division fixture",
  ],
]) {
  const step = Bun.spawn(["git", ...args], {
    cwd: project,
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "ignore",
    stderr: "pipe",
  })
  assert.equal(await step.exited, 0, await new Response(step.stderr).text())
}
await Bun.write(path.join(project, "math.ts"), source)
const certificate = path.join(home, "cert.pem")
const key = path.join(home, "key.pem")
const openssl = Bun.which("openssl")
assert(openssl, "This isolated acceptance needs openssl to create an ephemeral test CA.")
const ca = Bun.spawn(
  [
    openssl,
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
    "/CN=Vector isolated acceptance",
    "-addext",
    "subjectAltName=DNS:vectordev.ai,DNS:openrouter.ai",
  ],
  { stdout: "ignore", stderr: "pipe" },
)
assert.equal(await ca.exited, 0, await new Response(ca.stderr).text())

const catalog = {
  enabled: true,
  updatedAt: Date.now(),
  models: [
    {
      id: modelID,
      name: "Fixture free model",
      contextLength: 131072,
      maxOutputTokens: 4096,
      providers: [{ id: "modelrun", name: "Fixture provider", retention: "No retention in this local fixture." }],
    },
  ],
}
const limit = {
  type: "free_models_limit",
  code: "VECTOR_FREE_MODELS_LIMIT",
  reason: "user_daily",
  resetAt: Date.now() + 86400000,
  message: "The test free allowance is exhausted.",
}
const requests: Array<{ host: string; path: string; kind: string; model?: string }> = []
const denied: string[] = []
const fixtureFailures: string[] = []
const slowTitle = { started: false, aborted: false }
const messageText = (body: Record<string, unknown>) => JSON.stringify(body.messages)
const stream = (text: string, tool?: { name: string; arguments: Record<string, unknown> }) =>
  new Response(
    [
      {
        id: "chatcmpl_fixture",
        choices: [
          {
            delta: tool
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-fixture",
                      type: "function",
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(tool.arguments),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: text },
          },
        ],
      },
      {
        id: "chatcmpl_fixture",
        choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  async fetch(request) {
    const url = new URL(request.url)
    if (url.hostname === "vectordev.ai" && url.pathname === "/api/free-models/models") {
      requests.push({ host: url.hostname, path: url.pathname, kind: "catalog" })
      return Response.json(catalog)
    }
    if (url.hostname === "vectordev.ai" && url.pathname === "/api/account/cli-verify") {
      assert.deepEqual(await request.json(), { token })
      requests.push({ host: url.hostname, path: url.pathname, kind: "account" })
      return Response.json({
        ok: true,
        user: { id: "00000000-0000-4000-8000-000000000001", email: "fixture@example.invalid" },
      })
    }
    if (url.hostname === "vectordev.ai" && url.pathname === "/api/org/keys") {
      assert.equal(request.method, "GET")
      assert.equal(request.headers.get("authorization"), null)
      requests.push({ host: url.hostname, path: url.pathname, kind: "teams-disabled" })
      return Response.json(
        { error: { code: "TEAMS_NOT_CONFIGURED", message: "Vector Teams is not enabled or configured." } },
        { status: 503 },
      )
    }
    if (url.hostname === "openrouter.ai" && url.pathname === "/api/v1/models/user") {
      assert.equal(request.headers.get("authorization"), `Bearer ${ownKey}`)
      requests.push({ host: url.hostname, path: url.pathname, kind: "privacy-catalog" })
      return Response.json({
        data: [
          { id: modelID, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "tool_choice"] },
        ],
      })
    }
    const shared = url.hostname === "vectordev.ai" && url.pathname === "/api/free-models/chat"
    const own = url.hostname === "openrouter.ai" && url.pathname === "/api/v1/chat/completions"
    if (!shared && !own) {
      denied.push(url.href)
      return new Response("Unexpected fixture endpoint", { status: 403 })
    }
    assert.equal(request.headers.get("authorization"), `Bearer ${shared ? token : ownKey}`)
    const body = (await request.json()) as Record<string, unknown>
    assert.equal(body.model, modelID)
    assert.deepEqual(body.models, [modelID])
    assert.deepEqual(body.provider, {
      data_collection: "deny",
      require_parameters: true,
      only: ["modelrun"],
      max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    })
    assert.equal(body.plugins, undefined)
    const text = messageText(body)
    const title = text.includes("Generate a title for this conversation:")
    const quota = text.includes("ACCEPTANCE_QUOTA")
    const vectorscope = text.includes("You are Vector's code reviewer.")
    const read = text.includes(source.trim()) && text.includes('"role":"tool"')
    const kind = title
      ? text.includes("ACCEPTANCE_SLOW_TITLE")
        ? "slow-title"
        : "title"
      : quota
        ? shared
          ? "quota"
          : "resumed"
        : vectorscope
          ? read
            ? "vectorscope-result"
            : "vectorscope-tool"
          : read
            ? "review-result"
            : "review-tool"
    requests.push({ host: url.hostname, path: url.pathname, kind, model: String(body.model) })
    if (title) {
      if (text.includes("ACCEPTANCE_SLOW_TITLE")) {
        slowTitle.started = true
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 12_000)
          request.signal.addEventListener(
            "abort",
            () => {
              slowTitle.aborted = true
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      } else await Bun.sleep(250)
      return stream("Review divide guard")
    }
    if (quota && shared) return Response.json({ error: limit }, { status: 429 })
    if (quota && own) return stream("Resumed with the same conversation on my own free allowance.")
    if (vectorscope && read)
      return stream("", {
        name: "StructuredOutput",
        arguments: {
          summary: "The division change needs a guard for zero divisors.",
          risk: "medium",
          files: [{ path: "math.ts", note: "Division has an unguarded divisor." }],
          findings: [
            {
              path: "math.ts",
              line: 1,
              severity: "concern",
              category: "bug",
              title: "Guard against division by zero",
              body: "Passing zero as b produces Infinity because division has no guard.",
              confidence: 0.99,
            },
          ],
        },
      })
    return read
      ? stream("Review finding: math.ts lacks a zero-divisor guard.")
      : stream("", { name: "read", arguments: { filePath: path.join(project, "math.ts") } })
  },
  error(error) {
    fixtureFailures.push(error.message)
    return new Response("Fixture assertion failed", { status: 500 })
  },
})

const authorities: string[] = []
const proxy = createServer((_request, response) => response.writeHead(403).end())
proxy.on("connect", (request, client, head) => {
  const authority = request.url ?? ""
  authorities.push(authority)
  if (!["vectordev.ai:443", "openrouter.ai:443"].includes(authority)) {
    denied.push(authority)
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
const timings: Array<{ stage: string; durationMs: number }> = []
const command = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [
      process.execPath,
      "run",
      "--conditions=browser",
      ...(process.env.VECTOR_ACCEPTANCE_PRELOAD ? ["--preload", process.env.VECTOR_ACCEPTANCE_PRELOAD] : []),
      path.resolve(import.meta.dir, "../src/index.ts"),
    ]
const environment = {
  HOME: home,
  PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  VECTOR_TEST_HOME: home,
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  VECTOR_CLI: "1",
  VECTOR_CONFIG_CONTENT: JSON.stringify({
    formatter: false,
    lsp: false,
    snapshot: false,
    permission: { read: "allow" },
  }),
  VECTOR_DISABLE_PROJECT_CONFIG: "1",
  VECTOR_PURE: "1",
  VECTOR_DISABLE_AUTOUPDATE: "1",
  VECTOR_DISABLE_AUTOCOMPACT: "1",
  REVIEW_VERIFY: "off",
  VECTOR_MODELS_PATH: path.resolve(import.meta.dir, "../test/tool/fixtures/models-api.json"),
  VECTOR_SERVER_USERNAME: "vector",
  VECTOR_SERVER_PASSWORD: password,
  HTTPS_PROXY: proxyURL,
  https_proxy: proxyURL,
  HTTP_PROXY: proxyURL,
  http_proxy: proxyURL,
  ALL_PROXY: proxyURL,
  all_proxy: proxyURL,
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
  NODE_EXTRA_CA_CERTS: certificate,
}
const progress = { passed: false, stage: "login" }
const diagnostics = { server: Promise.resolve(""), locks: [] as Array<{ path: string; meta: unknown }> }
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
const spawn = (args: string[]) => {
  const child = Bun.spawn([...command, ...args], {
    cwd: project,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  return child
}
const capture = async (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder()
  const chunks: string[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const text = decoder.decode(chunk.value, { stream: true })
      chunks.push(text)
      if (process.env.VECTOR_ACCEPTANCE_PRELOAD) process.stderr.write(text)
    }
    return chunks.join("") + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
const run = async (args: string[], stage = args[0]) => {
  const started = performance.now()
  const child = spawn(args)
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000)
  const result = await Promise.all([child.exited, new Response(child.stdout).text(), capture(child.stderr)]).finally(
    () => clearTimeout(timer),
  )
  timings.push({ stage, durationMs: Math.round(performance.now() - started) })
  assert.equal(result[0], 0, `${args[0]} exited ${result[0]}\n${result[1]}\n${result[2]}`)
  return { stdout: result[1], stderr: result[2] }
}

try {
  const login = await run(["login", "--token", token])
  assert(login.stderr.includes("fixture@example.invalid"))
  progress.stage = "CLI review"
  const review = await run([
    "run",
    "--format",
    "json",
    "Review math.ts. Read the file and report its division edge case.",
  ])
  const reviewEvents = review.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; sessionID: string; part?: { type: string; text?: string } })
  assert(
    reviewEvents.some((event) => event.type === "text" && event.part?.text?.includes("zero-divisor guard")),
    review.stdout,
  )
  const reviewSessionID = reviewEvents[0].sessionID
  progress.stage = "CLI title cancellation"
  const slow = await run(
    [
      "run",
      "--format",
      "json",
      "ACCEPTANCE_SLOW_TITLE. Review math.ts. Read the file and report its division edge case.",
    ],
    "run (slow title)",
  )
  const slowSessionID = JSON.parse(slow.stdout.trim().split("\n")[0]).sessionID as string
  assert.equal(slowTitle.started, true, "The slow title request must actually start")
  assert.equal(slowTitle.aborted, true, "CLI shutdown must cancel its unfinished title request")
  progress.stage = "Vectorscope review"
  const vectorscope = JSON.parse(
    (await run(["review", "--uncommitted", "--json", "--no-security", "--fail-on", "never"])).stdout,
  )
  assert.equal(vectorscope.outcome?.cost?.kind, "free", JSON.stringify(vectorscope))
  assert.equal(vectorscope.outcome?.cost?.model, `vector/${modelID}`, JSON.stringify(vectorscope))
  assert(
    JSON.stringify(vectorscope.outcome?.selection).includes("Guard against division by zero"),
    JSON.stringify(vectorscope),
  )
  for await (const file of new Bun.Glob("**/*.lock").scan({ cwd: home, dot: true, onlyFiles: false }))
    diagnostics.locks.push({
      path: file,
      meta: await Bun.file(path.join(home, file, "meta.json"))
        .json()
        .catch(() => "empty"),
    })
  assert.deepEqual(diagnostics.locks, [], "Successful CLI shutdown must release even empty lock directories")
  const child = spawn(["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"])
  const stderr = new Response(child.stderr).text()
  diagnostics.server = stderr
  const ready = Promise.withResolvers<string>()
  const output: string[] = []
  const timer = setTimeout(() => {
    child.kill("SIGKILL")
    ready.reject(new Error("Acceptance engine startup timed out"))
  }, 20_000)
  const stdout = (async () => {
    const reader = child.stdout.getReader()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output.push(new TextDecoder().decode(chunk.value))
      const url = output.join("").match(/listening on (http:\/\/\S+)/)?.[1]
      if (url) ready.resolve(url)
    }
    if (!output.join("").includes("listening on"))
      ready.reject(new Error(`Acceptance engine exited ${await child.exited}: ${await stderr}`))
  })()
  const base = await ready.promise.finally(() => clearTimeout(timer))
  const api = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    progress.stage = `${method} ${route}`
    const started = performance.now()
    const response = await fetch(`${base}${route}`, {
      method,
      headers: {
        authorization: `Basic ${btoa(`vector:${password}`)}`,
        "content-type": "application/json",
        "x-vector-directory": project,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    timings.push({ stage: progress.stage, durationMs: Math.round(performance.now() - started) })
    assert(response.ok, `${method} ${route}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  const reviewSession = await api(`/session/${reviewSessionID}`)
  assert(timings.at(-1)!.durationMs < 20_000, "Fresh server startup must not wait for a stale credential lock")
  assert.equal(reviewSession.title, "Review divide guard")
  const slowSession = await api(`/session/${slowSessionID}`)
  assert(slowSession.title.startsWith("New session -"), "A cancelled title must not overwrite the durable session")
  const session = await api("/session", {})
  await api(`/session/${session.id}/message`, {
    model: { providerID: "vector", modelID },
    parts: [{ type: "text", text: "ACCEPTANCE_QUOTA continue this exact conversation after my free limit." }],
  })
  const before = (await api(`/session/${session.id}/message`)) as Array<{
    info: { id: string; role: string; error?: { name: string; data: unknown } }
    parts: Array<{ type: string; text?: string }>
  }>
  const failed = before.at(-1)
  assert.equal(failed?.info.error?.name, "FreeModelsLimitError")
  assert.deepEqual(failed?.info.error?.data, {
    code: limit.code,
    reason: limit.reason,
    resetAt: limit.resetAt,
    message: limit.message,
  })
  assert.equal(
    requests.filter((request) => request.kind === "quota").length,
    1,
    "Shared quota must not retry automatically",
  )
  await api("/auth/openrouter", { type: "api", key: ownKey }, "PUT")
  await api("/global/dispose", {})
  assert.equal(await api(`/session/${session.id}/free-models/resume`, { messageID: failed?.info.id, modelID }), true)
  const after = (await api(`/session/${session.id}/message`)) as typeof before
  assert.equal(
    after.filter((message) => message.info.role === "user").length,
    1,
    "Resume must not duplicate the user prompt",
  )
  assert.equal(after.find((message) => message.info.id === failed?.info.id)?.info.error, undefined)
  assert(
    after.some((message) =>
      message.parts.some((part) => part.text?.includes("same conversation on my own free allowance")),
    ),
  )
  assert.equal(requests.filter((request) => request.kind === "resumed").length, 1)
  assert.equal(requests.filter((request) => request.kind === "quota").length, 1)
  assert(requests.some((request) => request.kind === "review-tool"))
  assert(requests.some((request) => request.kind === "review-result"))
  assert(requests.some((request) => request.kind === "title"))
  assert(requests.some((request) => request.kind === "vectorscope-tool"))
  assert(requests.some((request) => request.kind === "vectorscope-result"))
  assert.deepEqual(denied, [])
  assert.deepEqual(fixtureFailures, [])
  child.kill("SIGKILL")
  await child.exited
  await stdout
  progress.passed = true
  console.log(
    JSON.stringify(
      {
        passed: true,
        binary: process.argv[2] ?? "source",
        checkedAt: new Date().toISOString(),
        reviewSessionID,
        resumedSessionID: session.id,
        requests,
        authorities,
        denied,
        fixtureFailures,
        isolatedTlsTrust: true,
        defaultModelUnconfigured: true,
        slowTitleCancelled: slowTitle.aborted,
        vectorscopeCostKind: vectorscope.outcome.cost.kind,
        paidRequests: 0,
        remainingLocks: diagnostics.locks,
        timings,
      },
      null,
      2,
    ),
  )
} finally {
  if (!progress.passed)
    console.error(JSON.stringify({ ...progress, requests, authorities, denied, fixtureFailures }, null, 2))
  children.forEach((child) => {
    if (child.exitCode === null) child.kill("SIGKILL")
  })
  await Promise.all(children.map((child) => child.exited))
  if (!progress.passed || process.env.VECTOR_ACCEPTANCE_PRELOAD) console.error(await diagnostics.server)
  upstream.stop(true)
  proxy.close()
  await rm(home, { recursive: true, force: true })
}
