import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("actual TUI agent set and cycle preserve free intent, including unavailable models", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-free-agent-"))
  try {
    // Isolate context fixtures in a child so module mocks cannot affect other TUI tests.
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "--preload",
        "@opentui/solid/preload",
        "-e",
        `
import { mock } from "bun:test"
import { createRoot } from "solid-js"
const free = { providerID: "openrouter", modelID: "maker/coder:free" }
const paid = { providerID: "openrouter", modelID: "maker/paid" }
const missing = { providerID: "openrouter", modelID: "maker/missing:FREE" }
const directory = process.argv[1]
const data = {
  agent: [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary", model: paid }],
  provider: [{ id: "openrouter", models: {
    [free.modelID]: { id: free.modelID, variants: { careful: {} }, freeModel: { source: "openrouter" } },
    [paid.modelID]: { id: paid.modelID, variants: {} },
  } }],
  provider_default: {}, provider_next: {}, config: { model: "openrouter/maker/coder:free" },
  session: [], mcp: {},
}
mock.module("./src/context/helper", () => ({ createSimpleContext: (input) => ({ provider: input.init }) }))
mock.module("./src/context/sync", () => ({ useSync: () => ({ data, status: "ready" }) }))
mock.module("./src/context/sdk", () => ({ useSDK: () => ({ url: "http://fixture.invalid", directory }) }))
mock.module("./src/context/event", () => ({ useEvent: () => ({ on() {} }) }))
mock.module("./src/context/runtime", () => ({ useTuiPaths: () => ({ state: directory }) }))
mock.module("./src/context/args", () => ({ useArgs: () => ({}) }))
mock.module("./src/context/theme", () => ({ useTheme: () => ({ theme: {} }) }))
mock.module("./src/context/route", () => ({ useRoute: () => ({ data: { type: "home" } }) }))
mock.module("./src/context/permission", () => ({ usePermission: () => ({}) }))
mock.module("./src/ui/toast", () => ({ useToast: () => ({ show() {} }) }))
const { LocalProvider } = await import("./src/context/local")
const result = createRoot((dispose) => {
  const local = LocalProvider({})
  local.model.variant.set("careful")
  local.agent.set("plan")
  const planned = { agent: local.agent.current().name, model: { ...local.model.current() }, variant: local.model.variant.current() }
  local.agent.move(-1)
  const cycled = { agent: local.agent.current().name, model: { ...local.model.current() }, variant: local.model.variant.current() }
  local.model.set(missing)
  local.agent.set("plan")
  const unavailable = { selected: { ...local.model.selection() }, current: local.model.current() ?? null }
  local.model.set(paid)
  const explicit = local.model.current()
  dispose()
  return { planned, cycled, unavailable, explicit }
})
await Bun.write(Bun.stdout, JSON.stringify(result))
`,
        directory,
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(25_000),
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    const free = { providerID: "openrouter", modelID: "maker/coder:free" }
    expect(JSON.parse(stdout)).toEqual({
      planned: { agent: "plan", model: free, variant: "careful" },
      cycled: { agent: "build", model: free, variant: "careful" },
      unavailable: { selected: { providerID: "openrouter", modelID: "maker/missing:FREE" }, current: null },
      explicit: { providerID: "openrouter", modelID: "maker/paid" },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
