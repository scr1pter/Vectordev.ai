import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { PluginLoader } from "../../src/plugin/loader"
import { tmpdir } from "../fixture/fixture"

async function load(file: string, source: "file" | "npm" = "file") {
  return PluginLoader.load({
    spec: file,
    target: file,
    entry: pathToFileURL(file).href,
    source,
    options: undefined,
    deprecated: false,
  })
}

describe("local plugin SDK resolution", () => {
  test("loads a real custom tool from an absent scoped SDK without editing its source", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "tool.ts")
    const source = `import { tool } from "@fixture-missing/plugin"
export default tool({ description: "fixture", args: { value: tool.schema.string() }, async execute(input) { return input.value } })`
    await Bun.write(file, source)
    const result = await load(file)
    if (!result.ok) throw result.error
    expect(result.ok).toBe(true)
    const definition = result.value.mod.default as { execute(input: { value: string }): Promise<string> }
    expect(await definition.execute({ value: "actual tool" })).toBe("actual tool")
    expect(await Bun.file(file).text()).toBe(source)
  })
  test("loads the real TUI SDK and follows local helper imports", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plugin.ts")
    await Bun.write(file, 'export { createBindingLookup } from "./helpers/tui.ts"')
    await Bun.write(
      path.join(tmp.path, "helpers/tui.ts"),
      'export { createBindingLookup } from "@fixture-tui/plugin/tui"',
    )
    const result = await load(file)
    if (!result.ok) throw result.error
    expect(result.ok).toBe(true)
    expect(typeof result.value.mod.createBindingLookup).toBe("function")
  })
  test("keeps an installed plugin SDK authoritative", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plugin.ts")
    const sdk = path.join(tmp.path, "node_modules/@fixture-pinned/plugin")
    await Bun.write(
      path.join(sdk, "package.json"),
      JSON.stringify({
        name: "@fixture-pinned/plugin",
        type: "module",
        exports: { ".": "./root.js", "./tui": "./tui.js" },
      }),
    )
    await Bun.write(path.join(sdk, "root.js"), 'export const identity = "pinned root"')
    await Bun.write(path.join(sdk, "tui.js"), 'export const identity = "pinned tui"')
    await Bun.write(
      file,
      'import { identity } from "@fixture-pinned/plugin"; export { identity }; export { identity as tui } from "@fixture-pinned/plugin/tui"',
    )
    const result = await load(file)
    if (!result.ok) throw result.error
    expect(result.ok).toBe(true)
    expect(result.value.mod).toMatchObject({ identity: "pinned root", tui: "pinned tui" })
    expect((await fs.lstat(sdk)).isSymbolicLink()).toBe(false)
  })
  test("fills a missing TUI export without changing the installed SDK root or manifest", async () => {
    await using tmp = await tmpdir()
    const sdk = path.join(tmp.path, "node_modules/@fixture-broken/plugin")
    const manifest = JSON.stringify({ name: "@fixture-broken/plugin", type: "module", exports: { ".": "./root.js" } })
    await Bun.write(path.join(sdk, "package.json"), manifest)
    await Bun.write(path.join(sdk, "root.js"), "export const pinned = true")
    await Bun.write(
      path.join(tmp.path, "broken.ts"),
      'export { pinned } from "@fixture-broken/plugin"; export { createBindingLookup } from "@fixture-broken/plugin/tui"',
    )
    const result = await load(path.join(tmp.path, "broken.ts"))
    if (!result.ok) throw result.error
    expect(result.value.mod.pinned).toBe(true)
    expect(typeof result.value.mod.createBindingLookup).toBe("function")
    expect(await Bun.file(path.join(sdk, "package.json")).text()).toBe(manifest)
    await Bun.write(path.join(tmp.path, "unrelated.ts"), 'export { x } from "@fixture-unrelated/not-plugin"')
    expect((await load(path.join(tmp.path, "unrelated.ts"))).ok).toBe(false)
  })
  test("preserves import.meta identity, local resources, and literal and computed dynamic imports", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plugin.ts")
    await Bun.write(path.join(tmp.path, "resource.txt"), "original resource")
    await Bun.write(path.join(tmp.path, "helper.ts"), 'export const value = "local helper"')
    await Bun.write(
      file,
      `import { tool } from "@fixture-meta/plugin"
export { tool }
export const meta = import.meta
export const same = import.meta === import.meta
export const resource = await Bun.file(new URL("./resource.txt", import.meta.url)).text()
export const literal = (await import("./helper.ts")).value
const dependency = "./helper.ts"
export const computed = (await import(dependency)).value
export const fromURL = (await import(new URL("./helper.ts", import.meta.url).href)).value
export const resolved = import.meta.resolve("./helper.ts")
`,
    )
    const result = await load(file)
    if (!result.ok) throw result.error
    expect(result.value.mod).toMatchObject({
      same: true,
      resource: "original resource",
      literal: "local helper",
      computed: "local helper",
      fromURL: "local helper",
      resolved: pathToFileURL(path.join(tmp.path, "helper.ts")).href,
    })
    expect(result.value.mod.meta).toMatchObject({
      url: pathToFileURL(file).href,
      path: file,
      filename: file,
      dir: tmp.path,
      dirname: tmp.path,
    })
    expect((await fs.readdir(tmp.path)).sort()).toEqual(["helper.ts", "plugin.ts", "resource.txt"])
  })
  test("keeps Solid TSX transformation while falling back through a TUI helper", async () => {
    const { testRender } = await import("@opentui/solid")
    const { ensureRuntimePluginSupport } = await import("@opentui/solid/runtime-plugin-support/configure")
    const { runtimeModules } = await import("@opentui/keymap/runtime-modules")
    ensureRuntimePluginSupport({ additional: runtimeModules })
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plugin.tsx")
    await Bun.write(path.join(tmp.path, "helper.ts"), 'export { createBindingLookup } from "@fixture-jsx/plugin/tui"')
    await Bun.write(
      file,
      'export { createBindingLookup } from "./helper.ts"; export default () => <text>Compatibility rendered</text>',
    )
    const result = await load(file)
    if (!result.ok) throw result.error
    const app = await testRender(result.value.mod.default as () => import("@opentui/solid").JSX.Element)
    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Compatibility rendered")
      expect(typeof result.value.mod.createBindingLookup).toBe("function")
    } finally {
      app.renderer.destroy()
    }
  })
  test("prepares computed local helpers and computed scoped SDK imports on demand", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plugin.ts")
    await Bun.write(path.join(tmp.path, "helper.ts"), 'export { tool } from "@fixture-computed-helper/plugin"')
    await Bun.write(
      file,
      `const helper = "./helper.ts"
const sdk = "@fixture-computed-sdk/plugin/tui"
export const tool = (await import(helper)).tool
export const createBindingLookup = (await import(sdk)).createBindingLookup
export const resolved = import.meta.resolve("./helper.ts")`,
    )
    const result = await load(file)
    if (!result.ok) throw result.error
    expect(typeof result.value.mod.tool).toBe("function")
    expect(typeof result.value.mod.createBindingLookup).toBe("function")
    expect(result.value.mod.resolved).toBe(pathToFileURL(path.join(tmp.path, "helper.ts")).href)
  })
  test("invalidates cached modules when an installed dependency resolves to a different file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plugin.ts")
    const sdk = path.join(tmp.path, "node_modules/@fixture-resolution/plugin")
    await Bun.write(path.join(sdk, "one.js"), 'export const pinned = "one"')
    await Bun.write(path.join(sdk, "two.js"), 'export const pinned = "two"')
    await Bun.write(
      file,
      'import { tool } from "@fixture-cache/plugin"; export { pinned } from "@fixture-resolution/plugin"; export { tool }',
    )
    const probe = path.join(tmp.path, "probe.ts")
    await Bun.write(
      probe,
      `import { LocalPluginSdk } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../../core/src/plugin/local-sdk.ts")).href)}
const target = await LocalPluginSdk.prepare(${JSON.stringify(file)})
console.log(JSON.stringify({ target, pinned: (await import(target)).pinned }))`,
    )
    const results = []
    for (const version of ["one", "two"]) {
      await Bun.write(
        path.join(sdk, "package.json"),
        JSON.stringify({ name: "@fixture-resolution/plugin", type: "module", exports: { ".": `./${version}.js` } }),
      )
      const child = Bun.spawn([process.execPath, "--no-env-file", probe], {
        cwd: tmp.path,
        env: {
          PATH: process.env.PATH,
          HOME: tmp.path,
          XDG_CACHE_HOME: path.join(tmp.path, "cache"),
          XDG_CONFIG_HOME: path.join(tmp.path, "config"),
          XDG_DATA_HOME: path.join(tmp.path, "data"),
          XDG_STATE_HOME: path.join(tmp.path, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const result = JSON.parse(stdout) as { target: string; pinned: string }
      expect(result.pinned).toBe(version)
      results.push(result.target)
    }
    expect(results[0]).not.toBe(results[1])
  })
  test("does not add an SDK alias for an npm plugin", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "npm-plugin.ts")
    await Bun.write(file, 'export { tool } from "@fixture-npm/plugin"')
    expect((await load(file, "npm")).ok).toBe(false)
    expect(
      await fs.lstat(path.join(tmp.path, "node_modules/@fixture-npm/plugin")).catch(() => undefined),
    ).toBeUndefined()
  })
})
