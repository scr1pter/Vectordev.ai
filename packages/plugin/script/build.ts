#!/usr/bin/env bun
import path from "node:path"
import { cp, mkdir, rm } from "node:fs/promises"
import { $ } from "bun"

const directory = path.resolve(import.meta.dirname, "..")

export async function stagePlugin(packageDirectory = directory, compile = true) {
  const root = path.resolve(packageDirectory, "../..")
  const sdk = path.join(root, "packages/sdk/js")
  if (compile) {
    await rm(path.join(sdk, "dist"), { recursive: true, force: true })
    await rm(path.join(packageDirectory, "dist"), { recursive: true, force: true })
    await $`bun run emit`.cwd(sdk)
    await $`bun run emit`.cwd(packageDirectory)
  }
  const output = path.join(packageDirectory, "dist-publish")
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await cp(path.join(packageDirectory, "dist"), path.join(output, "dist"), { recursive: true })
  const sdkManifest = await Bun.file(path.join(sdk, "package.json")).json()
  const source = await Bun.file(path.join(packageDirectory, "package.json")).json()
  const catalog = (await Bun.file(path.join(root, "package.json")).json()).workspaces.catalog
  for await (const file of new Bun.Glob("**/*.d.ts").scan(path.join(sdk, "dist"))) {
    await Bun.write(path.join(output, "dist/sdk", file), Bun.file(path.join(sdk, "dist", file)))
  }
  // SDK imports are type-only. Ship their full declaration tree instead of depending on a private package.
  for await (const file of new Bun.Glob("**/*.{js,d.ts}").scan(path.join(output, "dist"))) {
    const target = path.join(output, "dist", file)
    const text = await Bun.file(target).text()
    if (!text.includes('"@vectordevai/sdk') && !text.includes("'@vectordevai/sdk")) continue
    if (!file.endsWith(".d.ts")) throw new Error(`Plugin runtime unexpectedly imports the private SDK: ${file}`)
    const rewritten = text.replace(/(["'])@vectordevai\/sdk([^"']*)\1/g, (_match, quote: string, suffix: string) => {
      const entry = sdkManifest.exports[suffix ? `.${suffix}` : "."]
      if (typeof entry !== "string") throw new Error(`Unknown SDK declaration entry: ${suffix}`)
      const destination = path.join(output, "dist/sdk", entry.replace(/^\.\/src\//, "").replace(/\.ts$/, ".js"))
      const relative = path.relative(path.dirname(target), destination).split(path.sep).join("/")
      return `${quote}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`
    })
    await Bun.write(target, rewritten)
  }
  const dependencies = Object.fromEntries(
    Object.entries(source.dependencies as Record<string, string>)
      .filter(([name]) => name !== "@vectordevai/sdk")
      .map(([name, version]) => {
        const resolved = version === "catalog:" ? catalog[name] : version
        if (typeof resolved !== "string" || /^(workspace|catalog):/.test(resolved)) {
          throw new Error(`Unpublishable plugin dependency: ${name}@${version}`)
        }
        return [name, resolved]
      }),
  )
  const exports = Object.fromEntries(
    Object.entries(source.exports as Record<string, string>).map(([name, file]) => {
      const target = file.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "")
      return [name, { types: `${target}.d.ts`, import: `${target}.js` }]
    }),
  )
  const { devDependencies: _development, scripts: _scripts, ...manifest } = source
  await Bun.write(
    path.join(output, "package.json"),
    JSON.stringify(
      {
        ...manifest,
        private: false,
        license: "SEE LICENSE IN LICENSE",
        files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"],
        dependencies,
        exports,
      },
      null,
      2,
    ) + "\n",
  )
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    await Bun.write(path.join(output, notice), Bun.file(path.join(root, notice)))
  }
  await verifyPlugin(output)
  return output
}

export async function verifyPlugin(output: string) {
  const manifest = await Bun.file(path.join(output, "package.json")).json()
  const source = await Bun.file(path.resolve(output, "../package.json")).json()
  if (manifest.name !== source.name || manifest.version !== source.version) {
    throw new Error("Staged plugin identity does not match its source; rebuild before packaging")
  }
  if (manifest.private || manifest.dependencies?.["@vectordevai/sdk"]) throw new Error("Plugin requires a private SDK")
  if (manifest.license !== "SEE LICENSE IN LICENSE") throw new Error("Staged plugin license does not match its notices")
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    if (!manifest.files?.includes(notice) || !(await Bun.file(path.join(output, notice)).exists())) {
      throw new Error(`Missing plugin notice: ${notice}`)
    }
  }
  for (const entry of Object.values(manifest.exports as Record<string, { types: string; import: string }>)) {
    for (const file of [entry.types, entry.import]) {
      if (!(await Bun.file(path.join(output, file)).exists())) throw new Error(`Missing plugin export: ${file}`)
    }
  }
  for await (const file of new Bun.Glob("dist/**/*.{js,d.ts}").scan(output)) {
    const text = await Bun.file(path.join(output, file)).text()
    if (/["']@vectordevai\/sdk(?:["'/])/.test(text)) throw new Error(`Unresolved private SDK import: ${file}`)
    if (!file.endsWith(".d.ts")) continue
    for (const match of text.matchAll(/(?:from\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const reference = path.resolve(output, path.dirname(file), match[1].replace(/\.js$/, ".d.ts"))
      if (!reference.startsWith(path.resolve(output) + path.sep) || !(await Bun.file(reference).exists()))
        throw new Error(`Missing plugin declaration dependency: ${file} -> ${match[1]}`)
    }
  }
}

if (import.meta.main) console.log(await stagePlugin())
