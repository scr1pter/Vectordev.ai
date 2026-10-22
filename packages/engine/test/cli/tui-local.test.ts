import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// The terminal UI's threads under Vector Local: the main thread, the engine thread it starts, and a Worker that follows
// the main thread's guard, as OpenTUI's syntax highlighting worker does. Vector Local is turned on in the user's config
// while they run; the main thread's followers must refuse from then on, and what they refuse must reach the engine
// thread's log. It runs as a process of its own, with a home of its own and no company policy.

// A documentation address (TEST-NET-2): never routed, so a guard that failed to block would hang, not reach anyone.
const OUTSIDE = "198.51.100.7"
const CORE = path.join(import.meta.dir, "../../../core/src/local-mode")
const SOURCE = path.join(import.meta.dir, "../../src")
const at = (file: string) => JSON.stringify(file)

describe("the terminal UI under Vector Local", () => {
  test("refuses and logs what the main thread's Workers send once Vector Local is turned on mid-session", async () => {
    await using dir = await tmpdir()
    const config = path.join(dir.path, "config", "vector")
    mkdirSync(config, { recursive: true })
    writeFileSync(path.join(config, "vector.json"), JSON.stringify({ local: { enabled: false } }))
    const managed = `const { ConfigManaged } = await import(${at(path.join(SOURCE, "config/managed.ts"))})
ConfigManaged.useTestDirectory(process.env.MANAGED)`
    const engine = path.join(dir.path, "engine.ts")
    writeFileSync(
      engine,
      `import ${at(path.join(CORE, "backstop.ts"))}
${managed}
const { Egress } = await import(${at(path.join(CORE, "egress.ts"))})
const { Config } = await import(${at(path.join(SOURCE, "config/config.ts"))})
// As the engine's Config layer does.
Config.watchLocal()
self.onmessage = (event) => {
  const message = event.data
  if (message.type === "event") return Egress.report(message.event)
  if (message.type === "policy") return postMessage(Egress.policy().enabled)
  postMessage(Egress.events({ blocked: true }).map((item) => [item.source, item.origin, item.rule]))
}
postMessage("ready")
`,
    )
    const parser = path.join(dir.path, "parser.ts")
    writeFileSync(
      parser,
      `import { EgressGuard } from ${at(path.join(CORE, "guard.ts"))}
self.onmessage = async (event) => {
  if (event.data === "policy") return postMessage(EgressGuard.followed()?.enabled ?? "not following")
  for (let tries = 0; tries < 200 && !EgressGuard.followed()?.enabled; tries++) await Bun.sleep(10)
  // A guard that let it through would wait on an address that never answers; this one gives up first.
  const signal = AbortSignal.timeout(2_000)
  postMessage(await fetch("http://${OUTSIDE}/grammar.wasm", { signal }).then(() => "reached", (error) => error.name))
}
postMessage("ready")
`,
    )
    const main = path.join(dir.path, "main.ts")
    writeFileSync(
      main,
      `import ${at(path.join(CORE, "backstop.ts"))}
import { writeFileSync } from "node:fs"
${managed}
const { Egress } = await import(${at(path.join(CORE, "egress.ts"))})
const { TuiLocal } = await import(${at(path.join(SOURCE, "cli/tui/local.ts"))})
const started = (file) =>
  new Promise((resolve) => {
    const worker = new Worker(file)
    worker.onmessage = () => resolve(worker)
  })
const ask = (worker, message) =>
  new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data)
    worker.postMessage(message)
  })
const engine = await started(${at(engine)})
const parser = await started(${at(parser)})
TuiLocal.share((event) => engine.postMessage({ type: "event", event }))
const before = { main: Egress.policy().enabled, parser: await ask(parser, "policy") }
writeFileSync(${at(path.join(config, "vector.json"))}, JSON.stringify({ local: { enabled: true } }))
for (let tries = 0; tries < 200; tries++) {
  if (Egress.policy().enabled && (await ask(engine, { type: "policy" }))) break
  await Bun.sleep(25)
}
const after = { main: Egress.policy().enabled, engine: await ask(engine, { type: "policy" }) }
const fetched = await ask(parser, "go")
const logged = { value: [] }
for (let tries = 0; tries < 200 && logged.value.length === 0; tries++) {
  logged.value = await ask(engine, { type: "events" })
  if (logged.value.length === 0) await Bun.sleep(10)
}
console.log(JSON.stringify({ before, after, fetched, logged: logged.value }))
process.exit(0)
`,
    )
    const child = Bun.spawn([process.execPath, main], {
      cwd: dir.path,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(dir.path, "home"),
        XDG_CONFIG_HOME: path.join(dir.path, "config"),
        XDG_DATA_HOME: path.join(dir.path, "data"),
        XDG_CACHE_HOME: path.join(dir.path, "cache"),
        XDG_STATE_HOME: path.join(dir.path, "state"),
        MANAGED: path.join(dir.path, "managed"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const line = stdout.trim().split("\n").at(-1) ?? ""
    if (!line.startsWith("{")) throw new Error(`The terminal UI script printed no result:\n${stdout}\n${stderr}`)
    expect(JSON.parse(line)).toEqual({
      before: { main: false, parser: false },
      after: { main: true, engine: true },
      fetched: "EgressBlocked",
      logged: [["unlabelled", `http://${OUTSIDE}`, "unlabelled"]],
    })
  }, 60_000)
})
