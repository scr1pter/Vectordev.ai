import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("the TUI never picks a free model that may train as the default, even when it is the widest", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-free-default-"))
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
const directory = process.argv[1]
const model = (id, dataPolicy, context) => ({ id, variants: {}, limit: { context }, freeModel: { source: "openrouter", dataPolicy } })
const data = {
  agent: [{ name: "build", mode: "primary" }],
  provider: [{ id: "openrouter", models: {
    "maker/wide:free": model("maker/wide:free", "may-train", 1000000),
    "maker/unreviewed:free": model("maker/unreviewed:free", "unreviewed", 500000),
    "maker/narrow:free": model("maker/narrow:free", "no-training", 100000),
  } }],
  provider_default: {}, provider_next: {}, config: {},
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
  const current = { ...local.model.current() }
  dispose()
  return current
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
    // The may-train and unreviewed models are wider, so only the policy keeps them from being chosen for the user.
    expect(JSON.parse(stdout)).toEqual({ providerID: "openrouter", modelID: "maker/narrow:free" })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
