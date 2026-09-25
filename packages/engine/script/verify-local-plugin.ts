// Run after a native build: bun script/verify-local-plugin.ts dist/<platform>/bin/vector
import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

assert(process.argv[2], "Pass the compiled Vector binary to verify.")
const binary = path.resolve(process.argv[2])
const home = await mkdtemp(path.join(os.tmpdir(), "vector-compiled-plugin-"))
const project = path.join(home, "project")
const tool = path.join(project, ".vector/tools/probe.ts")
const source = `import { tool } from "@missing-fixture/plugin"
export default tool({
  description: "Synthetic compiled SDK probe",
  args: { input: tool.schema.string() },
  async execute(args) { return "compiled-sdk:" + args.input },
})
`

try {
  await Bun.write(tool, source)
  await Bun.write(
    path.join(project, "vector.json"),
    JSON.stringify({
      model: "fixture/unit",
      formatter: false,
      lsp: false,
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://127.0.0.1:1", apiKey: "synthetic-only" },
          models: { unit: { name: "Fixture" } },
        },
      },
    }),
  )
  await Bun.write(path.join(home, "models.json"), "{}")
  await Bun.write(
    path.join(home, "data/vector/cli-auth.json"),
    JSON.stringify({
      token: "vct_synthetic-plugin-smoke.synthetic",
      user: { id: "synthetic-plugin-smoke", email: "synthetic@example.invalid" },
      verifiedAt: Date.now(),
    }),
  )
  const child = Bun.spawn(
    [binary, "--print-logs", "debug", "agent", "build", "--tool", "probe", "--params", '{"input":"okay"}'],
    {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(home, "home"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        VECTOR_DISABLE_MODELS_FETCH: "true",
        VECTOR_MODELS_PATH: path.join(home, "models.json"),
        VECTOR_DISABLE_AUTOUPDATE: "true",
        VECTOR_DISABLE_DEFAULT_PLUGINS: "true",
        VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timer))
  assert.equal(code, 0, stderr)
  assert(stdout.includes("compiled-sdk:okay"), stdout)
  assert.equal(await Bun.file(tool).text(), source, "Compatibility loading must preserve the user's source.")
  const installed = (await readdir(home, { recursive: true })).filter(
    (file) => file.includes("node_modules") && file.includes("plugin"),
  )
  assert.deepEqual(installed, [], "The fallback SDK must be bundled, with no package-cache installation.")
  console.log("Compiled local plugin: passed; original source preserved; empty package cache.")
} finally {
  await rm(home, { recursive: true, force: true })
}
