import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Global } from "@vectordevai/core/global"
import { Npm } from "@vectordevai/core/npm"
import { ConfigDependencies } from "@/config/dependencies"
import { PluginDependencyVersion } from "@/config/plugin-version"
import { tmpdir } from "../fixture/fixture"

const dependencyLayer = (cache: string, add: Npm.Interface["add"]) =>
  LayerNode.compile(ConfigDependencies.node, [
    [Global.node, Global.layerWith({ cache })],
    [Npm.node, Layer.mock(Npm.Service, { add })],
  ])

async function loadOffline(entry: string, directory: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { PluginLoader } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/plugin/loader.ts"))};
       const loaded = await PluginLoader.load(${JSON.stringify({
         spec: entry,
         target: entry,
         entry: pathToFileURL(entry).href,
         source: "file",
         options: undefined,
         deprecated: false,
       })});
       if (!loaded.ok) throw loaded.error;
       console.log(JSON.stringify(loaded.value.mod.default));`,
    ],
    {
      env: {
        ...process.env,
        HOME: path.join(directory, "home"),
        VECTOR_TEST_HOME: path.join(directory, "home"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_STATE_HOME: path.join(directory, "state"),
        npm_config_registry: "http://127.0.0.1:1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(error).toBe("")
  return JSON.parse(output)
}

test("concurrent config consumers prepare one versioned SDK in the shared cache", async () => {
  await using tmp = await tmpdir()
  const calls: Array<[string, { timeout: number; force?: boolean } | undefined]> = []
  await Effect.gen(function* () {
    const dependencies = yield* ConfigDependencies.Service
    yield* Effect.all([dependencies.prepare(), dependencies.prepare()], { concurrency: "unbounded" })
    yield* dependencies.prepare()
  }).pipe(
    Effect.provide(
      dependencyLayer(tmp.path, (specifier, options) => {
        calls.push([specifier, options])
        return Effect.promise(async () => {
          await Bun.write(
            path.join(ConfigDependencies.directory(tmp.path), "package.json"),
            JSON.stringify({ name: ConfigDependencies.packageName }),
          )
          return { directory: ConfigDependencies.directory(tmp.path) }
        })
      }),
    ),
    Effect.runPromise,
  )
  expect(calls).toEqual([[`@vectordevai/plugin@${PluginDependencyVersion}`, { timeout: 5_000, force: true }]])
  await ConfigDependencies.Service.use((service) => service.prepare()).pipe(
    Effect.provide(
      dependencyLayer(tmp.path, (specifier, options) => {
        calls.push([specifier, options])
        return Effect.die("A completed SDK must not contact the registry again")
      }),
    ),
    Effect.runPromise,
  )
  expect(calls).toHaveLength(1)
  expect(await fs.readdir(tmp.path)).not.toContain("node_modules")
})

test("failed SDK setup is cooled down across fresh config runtimes", async () => {
  await using tmp = await tmpdir()
  const calls: string[] = []
  const prepare = () =>
    Effect.gen(function* () {
      const dependencies = yield* ConfigDependencies.Service
      yield* dependencies.prepare()
    }).pipe(
      Effect.provide(
        dependencyLayer(tmp.path, (specifier) => {
          calls.push(specifier)
          return Effect.fail(new Npm.InstallFailedError({ dir: tmp.path, cause: new Error("registry unavailable") }))
        }),
      ),
      Effect.runPromise,
    )
  await prepare()
  await prepare()
  expect(calls).toEqual([ConfigDependencies.specifier])
})

test("a stalled SDK setup finishes within the background deadline", async () => {
  await using tmp = await tmpdir()
  const started = performance.now()
  await Effect.gen(function* () {
    const dependencies = yield* ConfigDependencies.Service
    yield* dependencies.prepare()
  }).pipe(Effect.provide(dependencyLayer(tmp.path, () => Effect.never)), Effect.runPromise)
  expect(performance.now() - started).toBeLessThan(ConfigDependencies.timeout + 2_000)
}, 10_000)

test("cached SDK imports work offline through a shared link and preserve a project dependency", async () => {
  await using tmp = await tmpdir()
  const cache = path.join(tmp.path, "cache")
  const sdk = ConfigDependencies.directory(cache)
  await fs.mkdir(sdk, { recursive: true })
  await Bun.write(
    path.join(sdk, "package.json"),
    JSON.stringify({ name: ConfigDependencies.packageName, type: "module", main: "index.js" }),
  )
  await Bun.write(path.join(sdk, "index.js"), "export const tool = (value) => value;\n")
  await Bun.write(ConfigDependencies.readyFile(cache), ConfigDependencies.specifier)
  const first = path.join(tmp.path, "first", "plugin.mjs")
  const second = path.join(tmp.path, "second", "plugin.mjs")
  for (const file of [first, second]) {
    await Bun.write(file, 'import { tool } from "@vectordevai/plugin"; export default tool({ ready: true });\n')
    expect(await ConfigDependencies.link(pathToFileURL(file).href, cache)).toBe(true)
    expect((await import(file)).default).toEqual({ ready: true })
    expect(await fs.realpath(path.join(path.dirname(file), "node_modules", ConfigDependencies.packageName))).toBe(
      await fs.realpath(sdk),
    )
  }
  const pinned = path.join(tmp.path, "pinned", "node_modules", ConfigDependencies.packageName)
  await fs.mkdir(pinned, { recursive: true })
  await Bun.write(
    path.join(pinned, "package.json"),
    JSON.stringify({ name: ConfigDependencies.packageName, type: "module", main: "index.js" }),
  )
  await Bun.write(path.join(pinned, "index.js"), "export const tool = () => ({ pinned: true });\n")
  const file = path.join(tmp.path, "pinned", "plugins", "plugin.mjs")
  await Bun.write(file, 'import { tool } from "@vectordevai/plugin"; export default tool({});\n')
  expect(await ConfigDependencies.link(pathToFileURL(file).href, cache)).toBe(true)
  expect((await import(file)).default).toEqual({ pinned: true })
  expect(await Bun.file(path.join(pinned, "index.js")).text()).toContain("pinned: true")
  expect(await fs.lstat(path.join(path.dirname(file), "node_modules")).catch(() => undefined)).toBeUndefined()
})

test("an uncached SDK-dependent plugin uses the bundled SDK offline without installing it", async () => {
  await using tmp = await tmpdir()
  const entry = path.join(tmp.path, "plugin.mjs")
  const source =
    'import { tool } from "@vectordevai/plugin"; export default { value: tool.schema.string().parse("ready") };\n'
  await Bun.write(entry, source)
  expect(await loadOffline(entry, tmp.path)).toEqual({ value: "ready" })
  expect(await Bun.file(ConfigDependencies.readyFile(path.join(tmp.path, "cache", "vector"))).exists()).toBe(false)
  expect(await fs.lstat(path.join(tmp.path, "node_modules")).catch(() => undefined)).toBeUndefined()
  expect(await Bun.file(entry).text()).toBe(source)
})

test("an interrupted SDK install is not linked into a local plugin", async () => {
  await using tmp = await tmpdir()
  const cache = path.join(tmp.path, "cache")
  await Bun.write(
    path.join(ConfigDependencies.directory(cache), "package.json"),
    JSON.stringify({ name: ConfigDependencies.packageName }),
  )
  const entry = path.join(tmp.path, "plugin", "index.js")
  await Bun.write(entry, "export default {}\n")
  expect(await ConfigDependencies.link(entry, cache)).toBe(false)
  expect(await fs.lstat(path.join(path.dirname(entry), "node_modules")).catch(() => undefined)).toBeUndefined()
})

test("an SDK-dependent plugin prefers a completed shared SDK over its bundled fallback after restart", async () => {
  await using tmp = await tmpdir()
  const entry = path.join(tmp.path, "plugin.mjs")
  await Bun.write(entry, 'import { tool } from "@vectordevai/plugin"; export default tool({ source: "bundled" });\n')
  expect(await loadOffline(entry, tmp.path)).toEqual({ source: "bundled" })
  const cache = path.join(tmp.path, "cache", "vector")
  const sdk = ConfigDependencies.directory(cache)
  await Bun.write(
    path.join(sdk, "package.json"),
    JSON.stringify({ name: ConfigDependencies.packageName, type: "module", main: "index.js" }),
  )
  await Bun.write(path.join(sdk, "index.js"), 'export const tool = () => ({ source: "shared" });\n')
  await Bun.write(ConfigDependencies.readyFile(cache), ConfigDependencies.specifier)
  expect(await loadOffline(entry, tmp.path)).toEqual({ source: "shared" })
  expect(await fs.realpath(path.join(tmp.path, "node_modules", ConfigDependencies.packageName))).toBe(
    await fs.realpath(sdk),
  )
})
