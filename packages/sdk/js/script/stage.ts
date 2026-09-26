#!/usr/bin/env bun
import path from "node:path"
import { cp, mkdir, rm } from "node:fs/promises"
import { $ } from "bun"

const directory = path.resolve(import.meta.dirname, "..")
const notices = ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]

/** Source stays private; only this reviewed, compiled package is eligible for publication. */
export async function stageSdk(packageDirectory = directory, compile = true) {
  const root = path.resolve(packageDirectory, "../../..")
  if (compile) await $`bun run emit`.cwd(packageDirectory)
  const source = await Bun.file(path.join(packageDirectory, "package.json")).json()
  const catalog = (await Bun.file(path.join(root, "package.json")).json()).workspaces.catalog
  const version =
    process.env.VECTOR_SDK_VERSION ?? (await Bun.file(path.join(root, "packages/desktop/package.json")).json()).version
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Choose an exact SDK release version")
  const output = path.join(packageDirectory, "dist-publish")
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await cp(path.join(packageDirectory, "dist"), path.join(output, "dist"), { recursive: true })
  const dependencies = Object.fromEntries(
    Object.entries(source.dependencies as Record<string, string>).map(([name, value]) => {
      const resolved = value === "catalog:" ? catalog[name] : value
      if (typeof resolved !== "string" || /^(workspace|catalog):/.test(resolved))
        throw new Error(`Unpublishable SDK dependency: ${name}`)
      return [name, resolved]
    }),
  )
  const exports = Object.fromEntries(
    Object.entries(source.exports as Record<string, string>).map(([name, value]) => {
      if (!value.startsWith("./src/") || !value.endsWith(".ts")) throw new Error(`Unexpected SDK export: ${name}`)
      const target = value.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "")
      return [name, { types: `${target}.d.ts`, import: `${target}.js` }]
    }),
  )
  await Bun.write(
    path.join(output, "package.json"),
    JSON.stringify(
      {
        name: "@vectordevai/sdk",
        version,
        type: "module",
        private: false,
        description: "Typed JavaScript client and local server launcher for Vector",
        license: "SEE LICENSE IN LICENSE",
        homepage: "https://vectordev.ai/docs/sdk",
        engines: { node: ">=22" },
        exports,
        dependencies,
        files: ["dist", "README.md", ...notices],
      },
      null,
      2,
    ) + "\n",
  )
  for (const notice of notices) await Bun.write(path.join(output, notice), Bun.file(path.join(root, notice)))
  await Bun.write(path.join(output, "README.md"), Bun.file(path.join(packageDirectory, "README.md")))
  await verifySdk(output)
  return output
}

export async function verifySdk(output: string) {
  const source = await Bun.file(path.resolve(output, "../package.json")).json()
  const root = path.resolve(output, "../../../..")
  const version =
    process.env.VECTOR_SDK_VERSION ?? (await Bun.file(path.join(root, "packages/desktop/package.json")).json()).version
  const manifest = await Bun.file(path.join(output, "package.json")).json()
  if (
    manifest.name !== "@vectordevai/sdk" ||
    manifest.name !== source.name ||
    manifest.version !== version ||
    manifest.private !== false
  )
    throw new Error("SDK stage does not match the selected release; rebuild before packaging")
  if (manifest.license !== "SEE LICENSE IN LICENSE") throw new Error("SDK stage must preserve the reviewed license")
  if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(Object.keys(source.exports).sort()))
    throw new Error("SDK stage exports differ from source")
  if (
    Object.values(manifest.dependencies as Record<string, string>).some((value) =>
      /^(workspace|catalog|file|link):/.test(value),
    )
  )
    throw new Error("SDK stage contains a workspace dependency")
  for (const notice of notices) {
    if (
      !manifest.files.includes(notice) ||
      !Buffer.from(await Bun.file(path.join(output, notice)).arrayBuffer()).equals(
        Buffer.from(await Bun.file(path.join(root, notice)).arrayBuffer()),
      )
    )
      throw new Error(`SDK stage omits or changes ${notice}`)
  }
  for (const [name, entry] of Object.entries(manifest.exports as Record<string, { import: string; types: string }>)) {
    for (const file of [entry.import, entry.types]) {
      const destination = path.resolve(output, file)
      if (!destination.startsWith(path.resolve(output, "dist") + path.sep) || !(await Bun.file(destination).exists()))
        throw new Error(`SDK stage has a missing or unsafe export: ${name}`)
    }
  }
  for await (const file of new Bun.Glob("dist/**/*.{js,d.ts}").scan(output)) {
    const text = await Bun.file(path.join(output, file)).text()
    if (/@vectordevai\/(?:core|server|engine|schema)\b/.test(text))
      throw new Error(`SDK requires private runtime source: ${file}`)
    for (const match of text.matchAll(/(?:from\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.resolve(
        output,
        path.dirname(file),
        file.endsWith(".d.ts") ? match[1].replace(/\.js$/, ".d.ts") : match[1],
      )
      if (!target.startsWith(path.resolve(output, "dist") + path.sep) || !(await Bun.file(target).exists()))
        throw new Error(`SDK stage contains a missing relative import: ${file}`)
    }
  }
}

if (import.meta.main) console.log(await stageSdk())
