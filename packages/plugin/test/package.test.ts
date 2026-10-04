import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stagePlugin, verifyPlugin } from "../script/build"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-plugin-package-"))
  const directory = path.join(root, "packages/plugin")
  await Bun.write(
    path.join(root, "packages/desktop/package.json"),
    JSON.stringify({ version: "9.9.9", vectorRequiredCliVersion: "1.2.3" }),
  )
  await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { catalog: { zod: "4.1.8" } } }))
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@vectordevai/plugin",
      version: "0.0.0-test",
      type: "module",
      license: "MIT",
      exports: { ".": "./src/index.ts", "./tui": "./src/tui.ts" },
      dependencies: { "@vectordevai/sdk": "workspace:*", zod: "catalog:" },
      devDependencies: { typescript: "catalog:" },
    }),
  )
  await Bun.write(
    path.join(root, "packages/sdk/js/package.json"),
    JSON.stringify({
      name: "@vectordevai/sdk",
      private: true,
      exports: { ".": "./src/index.ts", "./v2/types": "./src/v2/gen/types.gen.ts" },
    }),
  )
  await Bun.write(
    path.join(root, "packages/sdk/js/dist/index.d.ts"),
    'export type { Config } from "./v2/gen/types.gen.js"\n',
  )
  await Bun.write(
    path.join(root, "packages/sdk/js/dist/v2/gen/types.gen.d.ts"),
    "export type Config = { model?: string }\n",
  )
  await Bun.write(path.join(directory, "dist/index.js"), 'export const identity = "fixture"\n')
  await Bun.write(
    path.join(directory, "dist/index.d.ts"),
    'import type { Config } from "@vectordevai/sdk"\nexport type Plugin = (config: Config) => void\n',
  )
  await Bun.write(path.join(directory, "dist/tui.js"), 'export const identity = "tui fixture"\n')
  await Bun.write(
    path.join(directory, "dist/tui.d.ts"),
    'export type Options = import("@vectordevai/sdk/v2/types").Config\n',
  )
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    await Bun.write(path.join(root, file), `Fixture notice ${file}\n`)
  }
  return { root, directory, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) }
}

test("staged plugin closes private SDK types, resolves public versions, and exposes existing files", async () => {
  await using tmp = await fixture()
  const original = await Bun.file(path.join(tmp.directory, "package.json")).text()
  const output = await stagePlugin(tmp.directory, false)
  const manifest = await Bun.file(path.join(output, "package.json")).json()
  expect(manifest.dependencies).toEqual({ zod: "4.1.8" })
  expect(manifest.version).toBe("1.2.3")
  expect(manifest.devDependencies).toBeUndefined()
  expect(manifest.exports["."].types).toBe("./dist/index.d.ts")
  expect(await Bun.file(path.join(output, "dist/index.d.ts")).text()).toContain('from "./sdk/index.js"')
  expect(await Bun.file(path.join(output, "dist/tui.d.ts")).text()).toContain('import("./sdk/v2/gen/types.gen.js")')
  expect(await Bun.file(path.join(output, "dist/sdk/v2/gen/types.gen.d.ts")).exists()).toBe(true)
  expect(await Bun.file(path.join(output, "THIRD_PARTY_NOTICES.md")).text()).toBe(
    "Fixture notice THIRD_PARTY_NOTICES.md\n",
  )
  expect(await Bun.file(path.join(tmp.directory, "package.json")).text()).toBe(original)
})

test("missing transitive SDK declarations fail closed", async () => {
  await using tmp = await fixture()
  const output = await stagePlugin(tmp.directory, false)
  await rm(path.join(output, "dist/sdk/v2/gen/types.gen.d.ts"))
  await expect(verifyPlugin(output)).rejects.toThrow("Missing plugin declaration dependency")
})

test("a runtime private SDK import cannot silently ship in the public package", async () => {
  await using tmp = await fixture()
  await Bun.write(path.join(tmp.directory, "dist/index.js"), 'import "@vectordevai/sdk"\n')
  await expect(stagePlugin(tmp.directory, false)).rejects.toThrow("Plugin runtime unexpectedly imports the private SDK")
})

test("a stale stage cannot be published under a newer source version", async () => {
  await using tmp = await fixture()
  const output = await stagePlugin(tmp.directory, false)
  const file = Bun.file(path.join(tmp.root, "packages/desktop/package.json"))
  await file.write(JSON.stringify({ version: "9.9.9", vectorRequiredCliVersion: "1.2.4" }))
  await expect(verifyPlugin(output)).rejects.toThrow("Staged plugin identity does not match its source")
})

test("missing required notices fail before packing", async () => {
  await using tmp = await fixture()
  const output = await stagePlugin(tmp.directory, false)
  await rm(path.join(output, "LICENSE"))
  await expect(verifyPlugin(output)).rejects.toThrow("Missing plugin notice: LICENSE")
})
