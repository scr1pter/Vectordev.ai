import { expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm } from "node:fs/promises"
import { stageSdk, verifySdk } from "../script/stage"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-sdk-stage-"))
  const directory = path.join(root, "packages/sdk/js")
  await Bun.write(
    path.join(root, "package.json"),
    JSON.stringify({ workspaces: { catalog: { "cross-spawn": "7.0.6" } } }),
  )
  await Bun.write(path.join(root, "packages/desktop/package.json"), JSON.stringify({ version: "0.0.0-fixture" }))
  await Bun.write(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@vectordevai/sdk",
      private: true,
      exports: { ".": "./src/index.ts" },
      dependencies: { "cross-spawn": "catalog:" },
    }),
  )
  await Bun.write(path.join(directory, "dist/index.js"), 'export { value } from "./value.js"\n')
  await Bun.write(path.join(directory, "dist/index.d.ts"), 'export { value } from "./value.js"\n')
  await Bun.write(path.join(directory, "dist/value.js"), 'export const value = "fixture"\n')
  await Bun.write(path.join(directory, "dist/value.d.ts"), "export declare const value: string\n")
  await Bun.write(path.join(directory, "README.md"), "Fixture SDK")
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await Bun.write(path.join(root, file), `Fixture ${file}`)
  return { root, directory, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) }
}

test("stages compiled exports with exact public dependencies and intact notices", async () => {
  await using sample = await fixture()
  const output = await stageSdk(sample.directory, false)
  const manifest = await Bun.file(path.join(output, "package.json")).json()
  expect(manifest).toMatchObject({
    name: "@vectordevai/sdk",
    version: process.env.VECTOR_SDK_VERSION ?? "0.0.0-fixture",
    private: false,
    dependencies: { "cross-spawn": "7.0.6" },
    exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  })
  expect((await Bun.file(path.join(sample.directory, "package.json")).json()).private).toBe(true)
  await verifySdk(output)
  await Bun.write(path.join(output, "LICENSE"), "changed")
  await expect(verifySdk(output)).rejects.toThrow("changes LICENSE")
})

test("rejects broken declaration trees and private runtime imports", async () => {
  await using sample = await fixture()
  const output = await stageSdk(sample.directory, false)
  await rm(path.join(output, "dist/value.d.ts"))
  await expect(verifySdk(output)).rejects.toThrow("missing relative import")
  await Bun.write(path.join(output, "dist/value.d.ts"), "export declare const value: string\n")
  await Bun.write(path.join(output, "dist/value.js"), 'export { value } from "@vectordevai/core/private"\n')
  await expect(verifySdk(output)).rejects.toThrow("private runtime source")
})
