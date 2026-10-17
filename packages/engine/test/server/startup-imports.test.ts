import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

// Packages that only one feature uses. Every `vector run` and every engine loads the server module graph, so these
// must load on first use rather than with it: each costs parse time and resident memory on every start.
const FEATURE_ONLY = [
  // language servers
  "vscode-jsonrpc",
  // package installs and registry reads
  "@npmcli/config",
  // mDNS publishing of a network listener
  "bonjour-service",
  // turndown's DOM, for webfetch markdown conversion
  "@mixmark-io/domino",
  // MCP servers: the SDK, its own zod copy and its JSON Schema validator
  "@modelcontextprotocol/sdk",
  // GitLab models
  "gitlab-ai-provider",
  // the experimental OpenTelemetry exporter
  "@effect/opentelemetry",
  // Redis, which Vector never uses: only the "@effect/platform-node" index loads it, with cluster and worker support
  "ioredis",
]

test("the server module graph loads without feature-only packages", async () => {
  await using tmp = await tmpdir()
  const inventory = path.join(tmp.path, "modules.json")
  // A separate process, so modules other test files already loaded do not count.
  const child = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      "--eval",
      // A regular file avoids large stdout truncation and platform-specific pipe flush behavior.
      `await import("./src/server/server.ts"); await Bun.write(process.env.VECTOR_TEST_IMPORT_GRAPH, JSON.stringify(Object.keys(require.cache)))`,
    ],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: { ...process.env, VECTOR_TEST_IMPORT_GRAPH: inventory },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" })
  const loaded = ((await Bun.file(inventory).json()) as string[]).map((file) => file.replaceAll("\\", "/"))
  // The server graph itself must still be what was loaded.
  expect(loaded.some((file) => file.endsWith("/src/server/server.ts"))).toBe(true)
  expect(FEATURE_ONLY.filter((name) => loaded.some((file) => file.includes(`/node_modules/${name}/`)))).toEqual([])
}, 120_000)
