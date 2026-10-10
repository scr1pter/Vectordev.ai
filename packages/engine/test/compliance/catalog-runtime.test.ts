import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { catalogBody, catalogDigest } from "../../script/release-catalog"

const input = {
  lmstudio: {
    id: "lmstudio",
    name: "Local",
    env: [],
    models: {
      local: {
        id: "local",
        name: "Local model",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        tool_call: true,
        limit: { context: 8192, output: 1024 },
        provider: { npm: "@jerome-benoit/sap-ai-provider-v2" },
        extra: { retained: true },
      },
    },
  },
}
const prepared = catalogBody(JSON.stringify(input))
const expected = JSON.parse(prepared)

async function bundle(target: "bun" | "node", define: Record<string, string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-catalog-runtime-"))
  // Match the desktop builder's external dependencies, resolved from this package's installation.
  await symlink(path.resolve(import.meta.dirname, "../../node_modules"), path.join(directory, "node_modules"), "dir")
  // Isolate each compiler invocation from the test runner's module and file caches.
  await capture(
    [
      process.execPath,
      "--eval",
      `const result = await Bun.build(${JSON.stringify({
        entrypoints: [path.resolve(import.meta.dirname, "../fixture/catalog-runtime.ts")],
        outdir: directory,
        naming: "catalog.mjs",
        target,
        format: "esm",
        minify: target === "bun",
        external: target === "node" ? ["jsonc-parser", "@lydell/node-pty"] : [],
        define,
      })}); if (!result.success) { console.error(result.logs); process.exitCode = 1 }`,
    ],
    directory,
    { PATH: process.env.PATH, HOME: directory },
  ).catch(async (error) => {
    await rm(directory, { recursive: true, force: true })
    throw error
  })
  return {
    directory,
    target,
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  }
}

async function run(built: Awaited<ReturnType<typeof bundle>>, bytes?: string, env: Record<string, string> = {}) {
  const file = path.join(built.directory, "input.json")
  if (bytes === undefined) await rm(file, { force: true })
  if (bytes !== undefined) await Bun.write(file, bytes)
  const stdout = await capture(
    [built.target === "node" ? "node" : process.execPath, path.join(built.directory, "catalog.mjs")],
    built.directory,
    {
      PATH: process.env.PATH,
      HOME: built.directory,
      XDG_DATA_HOME: path.join(built.directory, "data"),
      XDG_CACHE_HOME: path.join(built.directory, "cache"),
      XDG_CONFIG_HOME: path.join(built.directory, "config"),
      XDG_STATE_HOME: path.join(built.directory, "state"),
      TMPDIR: built.directory,
      VECTOR_AGENT_DB: ":memory:",
      VECTOR_MODELS_PATH: file,
      VECTOR_DISABLE_MODELS_FETCH: "true",
      ...env,
    },
  )
  const result = JSON.parse(stdout.trim().split("\n").at(-1)!)
  expect(result.cached).toBe(true)
  expect(result.fresh).toEqual(result.catalog)
  return result.catalog
}

async function capture(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => proc.kill(), 20_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, `${stderr}\n${stdout}`).toBe(0)
    return stdout
  } finally {
    clearTimeout(timeout)
    proc.kill()
    await proc.exited
  }
}

for (const target of ["bun", "node"] as const) {
  test(`the ${target} catalog bundle preserves snapshot, disk and fresh-service behavior`, async () => {
    await using built = await bundle(target, {
      VECTOR_MODEL_CATALOG: prepared,
    })
    expect(await run(built)).toEqual(expected)
    expect(await run(built, prepared)).toEqual(expected)
    const changed = { lmstudio: { ...input.lmstudio, name: "Changed disk provider" } }
    expect(await run(built, `\uFEFF${JSON.stringify(changed)}`)).toEqual(ModelCatalog.decodeCatalog(changed))
    expect(await run(built, "{broken")).toEqual(expected)
    expect(await run(built, JSON.stringify({ lmstudio: { ...input.lmstudio, id: "mismatch" } }))).toEqual(expected)
  }, 120_000)
}

test("bundled snapshots are normalized and validated", async () => {
  await using built = await bundle("bun", { VECTOR_MODEL_CATALOG: JSON.stringify(input) })
  expect(await run(built)).toEqual(expected)
  expect(await run(built, JSON.stringify(input))).toEqual(expected)
}, 60_000)

test("a build without a snapshot validates disk data and tolerates its absence", async () => {
  const changed = { lmstudio: { ...input.lmstudio, npm: "unbundled-catalog-sdk" } }
  const bytes = JSON.stringify(changed)
  await using built = await bundle("bun", {})
  expect(await run(built, bytes)).toEqual({})
  expect(await run(built)).toEqual({})
}, 60_000)

test("runtime environment variables cannot supply catalog trust", async () => {
  await using built = await bundle("bun", {})
  const changed = { lmstudio: { ...input.lmstudio, npm: "unbundled-catalog-sdk" } }
  const bytes = JSON.stringify(changed)
  expect(
    await run(built, bytes, {
      VECTOR_MODEL_CATALOG: prepared,
      VECTOR_MODEL_CATALOG_SHA256: catalogDigest(bytes),
    }),
  ).toEqual({})
}, 60_000)
