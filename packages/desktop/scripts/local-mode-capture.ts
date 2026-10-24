import { createRequire } from "node:module"
import { mkdir, mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { auditLocalCapture, capturePackets, type CaptureWorkload } from "./local-mode-capture-audit"
import desktop from "../package.json"

const output = path.resolve(process.argv[2] ?? "local-capture-evidence")
if (process.argv.includes("--audit")) {
  const workload: CaptureWorkload = await Bun.file(path.join(output, "workload.json")).json()
  const events = Schema.decodeUnknownSync(Schema.Array(LocalMode.Event))(
    await Bun.file(path.join(output, "events.json")).json(),
  )
  const capture = await Bun.file(path.join(output, "tcpdump.log")).text()
  const dropped = /^(\d+) packets dropped by kernel$/m.exec(capture)
  const result = auditLocalCapture({
    workload,
    events,
    packets: capturePackets(await Bun.file(path.join(output, "packets.json")).json()),
    isolated: (await Bun.file(path.join(output, "isolation.json")).json()).isolated === true,
    dropped: dropped ? Number(dropped[1]) : -1,
  })
  await Bun.write(path.join(output, "result.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.passed ? 0 : 1)
}

const duration = Number(process.env.VECTOR_CAPTURE_DURATION_MS ?? 1_800_000)
if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 1_900_000)
  throw new Error("Invalid capture duration")
const root = await mkdtemp(path.join(tmpdir(), "vector-local-capture-"))
await mkdir(output, { recursive: true })
await mkdir(path.join(root, "repository"))
await Bun.write(path.join(root, "repository", "notes.txt"), "The local capture fixture is ready.\n")
const bundle = path.resolve(process.env.VECTOR_CAPTURE_ENGINE ?? "../engine/dist/node/node.js")
const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim()
const engineSha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(bundle).arrayBuffer()).digest("hex")
const hits: { time: number; method: string; host: string; path: string }[] = []
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    hits.push({ time: Date.now(), method: request.method, host: request.headers.get("host") ?? "", path: url.pathname })
    if (url.pathname === "/v1/chat/completions") {
      const body = (await request.json()) as {
        messages?: { role: string }[]
        tools?: { function?: { name?: string } }[]
      }
      const read =
        body.messages?.some((message) => message.role === "tool") ||
        !body.tools?.some((tool) => tool.function?.name === "read")
      const delta = read
        ? { content: "The local capture fixture is ready." }
        : {
            tool_calls: [
              {
                index: 0,
                id: "capture_read",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ filePath: path.join(root, "repository", "notes.txt") }),
                },
              },
            ],
          }
      const chunk = (value: object) =>
        `data: ${JSON.stringify({ id: "capture", object: "chat.completion.chunk", choices: [{ index: 0, ...value }] })}\n\n`
      return new Response(
        chunk({ delta: { role: "assistant" } }) +
          chunk({ delta }) +
          chunk({ delta: {}, finish_reason: read ? "stop" : "tool_calls" }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    if (url.pathname === "/page")
      return new Response(
        `<!doctype html><title>Capture</title><link rel=icon href=data:,><script src="http://cdn.web.test:${fixture.port}/a.js"></script><script src="http://cdn.web.test:${fixture.port}/b.js"></script><img src="http://image.web.test:${fixture.port}/pixel">`,
        { headers: { "content-type": "text/html", "cache-control": "no-store" } },
      )
    if (url.pathname === "/redirect") return Response.redirect(`http://news.web.test:${fixture.port}/page`)
    if (url.pathname.endsWith(".js"))
      return new Response("window.captureScripts=(window.captureScripts||0)+1", {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      })
    return new Response("<!doctype html><title>Local capture fixture</title><link rel=icon href=data:,>", {
      headers: { "content-type": "text/html", "cache-control": "no-store" },
    })
  },
})
const base = `http://127.0.0.1:${fixture.port}`
const model = {
  id: "fixture",
  name: "Capture fixture",
  tool_call: true,
  attachment: false,
  reasoning: false,
  temperature: false,
  limit: { context: 100000, output: 8000 },
  cost: { input: 0, output: 0 },
}
const environment = {
  PATH: process.env.PATH ?? "",
  VECTOR_TEST_HOME: root,
  VECTOR_AGENT_CONFIG_DIR: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_STATE_HOME: path.join(root, "state"),
  VECTOR_CLIENT: "desktop",
  VECTOR_AUTH_CONTENT: "{}",
  VECTOR_PURE: "1",
  VECTOR_DISABLE_PROJECT_CONFIG: "1",
  VECTOR_DISABLE_CHANNEL_DB: "1",
  VECTOR_DISABLE_MODELS_FETCH: "1",
  VECTOR_LOCAL: "1",
  VECTOR_LOCAL_WEB: "none",
  VECTOR_LOCAL_POLICY: JSON.stringify({ endpoints: [base] }),
  VECTOR_CAPTURE_WEB_ORIGIN: base,
  VECTOR_CONFIG_CONTENT: JSON.stringify({
    model: "capture/fixture",
    small_model: "capture/fixture",
    formatter: false,
    lsp: false,
    provider: {
      capture: {
        name: "Capture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: { fixture: model },
        options: { apiKey: "", baseURL: `${base}/v1`, concurrency: 1 },
      },
    },
  }),
}
const engine = Bun.spawn(["node", path.join(import.meta.dir, "local-mode-capture-engine.mjs"), bundle], {
  cwd: root,
  env: environment,
  stdin: "ignore",
  stdout: "pipe",
  stderr: Bun.file(path.join(output, "engine.stderr.log")),
})
const engineOutput: string[] = []
const reading = (async () => {
  for await (const bytes of engine.stdout) engineOutput.push(new TextDecoder().decode(bytes))
})()
const waitFor = async (test: () => boolean, timeout: number) => {
  const started = Date.now()
  while (!test()) {
    if (Date.now() - started > timeout) throw new Error("Capture engine startup timed out")
    await Bun.sleep(100)
  }
}
try {
  await waitFor(() => /capture:listening (\S+)/.test(engineOutput.join("")), 60_000)
  const engineURL = /capture:listening (\S+)/.exec(engineOutput.join(""))![1]!
  const config = {
    root,
    output,
    duration,
    base,
    engineURL,
    repository: path.join(root, "repository"),
    revision,
    engineSha256,
    desktopVersion: desktop.version,
  }
  await Bun.write(path.join(root, "input.json"), JSON.stringify(config))
  const built = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "local-mode-capture-electron.ts")],
    target: "node",
    format: "esm",
    outdir: root,
    naming: "capture.mjs",
    external: ["electron"],
  })
  if (!built.success) throw new AggregateError(built.logs, "Capture entry did not bundle")
  const require = createRequire(import.meta.url)
  const directory = path.dirname(require.resolve("electron/package.json"))
  const binary = path.join(directory, "dist", (await Bun.file(path.join(directory, "path.txt")).text()).trim())
  const child = Bun.spawn([binary, path.join(root, "capture.mjs"), path.join(root, "input.json")], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: Bun.file(path.join(output, "electron.stderr.log")),
    env: {
      ...environment,
      VECTOR_LOCAL_WEB: "ask",
      VECTOR_CONFIG_CONTENT: "{}",
      DISPLAY: process.env.DISPLAY ?? "",
      XAUTHORITY: process.env.XAUTHORITY ?? "",
    },
  })
  const timer = setTimeout(() => child.kill(), duration + 120_000)
  const exited = await child.exited
  clearTimeout(timer)
  if (exited !== 0) throw new Error(`Electron capture workload failed: ${exited}`)
  const desktopEvents: LocalMode.Event[] = await Bun.file(path.join(output, "desktop-events.json")).json()
  const logDirectory = path.join(root, "data", "vector", "local")
  const engineEvents = (
    await Promise.all(
      (await readdir(logDirectory))
        .filter((name) => /^egress-.*\.jsonl$/.test(name))
        .map(async (name) =>
          (await Bun.file(path.join(logDirectory, name)).text())
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        ),
    )
  ).flat()
  await Bun.write(path.join(output, "events.json"), JSON.stringify([...desktopEvents, ...engineEvents], null, 2))
  await Bun.write(path.join(output, "fixture-hits.json"), JSON.stringify(hits, null, 2))
  console.log(`Capture workload complete; duration=${duration}; short runs do not pass the release gate`)
} finally {
  engine.kill()
  await engine.exited
  await reading
  await Bun.write(path.join(output, "engine.stdout.log"), engineOutput.join(""))
  fixture.stop(true)
}
