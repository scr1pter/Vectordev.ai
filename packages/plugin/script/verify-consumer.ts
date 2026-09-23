#!/usr/bin/env bun
import path from "node:path"
import os from "node:os"
import { mkdtemp, rm, realpath } from "node:fs/promises"
import { stagePlugin, verifyPlugin } from "./build"

const directory = path.resolve(import.meta.dirname, "..")
const root = path.resolve(directory, "../..")
const output = process.argv.includes("--skip-build") ? path.join(directory, "dist-publish") : await stagePlugin()
await verifyPlugin(output)
const consumer = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-plugin-consumer-")))
const manifest = await Bun.file(path.join(output, "package.json")).json()
const catalog = (await Bun.file(path.join(root, "package.json")).json()).workspaces.catalog
const environment = {
  PATH: process.env.PATH,
  HOME: consumer,
  NPM_CONFIG_USERCONFIG: path.join(consumer, "user.npmrc"),
  NPM_CONFIG_GLOBALCONFIG: path.join(consumer, "global.npmrc"),
  NPM_CONFIG_CACHE: path.join(consumer, "npm-cache"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
}
for (const file of ["user.npmrc", "global.npmrc"]) await Bun.write(path.join(consumer, file), "")

async function run(command: string[], cwd = consumer) {
  const process = Bun.spawn(command, { cwd, env: environment, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code})\n${stdout}\n${stderr}`)
  return stdout
}

try {
  const packed = JSON.parse(
    await run(["npm", "pack", "--offline", "--json", "--pack-destination", consumer], output),
  )[0]
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    if (!packed.files.some((entry: { path: string }) => entry.path === file)) throw new Error(`Tarball omits ${file}`)
  }
  await Bun.write(
    path.join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "vector-plugin-consumer",
        private: true,
        type: "module",
        scripts: { typecheck: "tsc --noEmit" },
        dependencies: {
          "@vectordevai/plugin": `file:./${packed.filename}`,
          ...Object.fromEntries(Object.keys(manifest.peerDependencies ?? {}).map((name) => [name, catalog[name]])),
        },
        devDependencies: {
          typescript: catalog.typescript,
          "@types/node": catalog["@types/node"],
          "@types/bun": catalog["@types/bun"],
        },
      },
      null,
      2,
    ),
  )
  await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"])
  if (await Bun.file(path.join(consumer, "node_modules/@vectordevai/sdk/package.json")).exists()) {
    throw new Error("Consumer installed the private SDK")
  }
  const installed = await realpath(path.join(consumer, "node_modules/@vectordevai/plugin"))
  if (!installed.startsWith(consumer + path.sep)) throw new Error("Consumer resolved a workspace symlink")
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    if (
      Buffer.compare(
        Buffer.from(await Bun.file(path.join(installed, file)).arrayBuffer()),
        Buffer.from(await Bun.file(path.join(root, file)).arrayBuffer()),
      ) !== 0
    ) {
      throw new Error(`Packaged notice changed: ${file}`)
    }
  }
  await Bun.write(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: ["node", "bun"],
      },
      include: ["*.ts"],
    }),
  )
  const sources = {
    "root.ts": `import { tool, type Plugin, type Permission } from "@vectordevai/plugin"
const definition = tool({ description: "fixture", args: { value: tool.schema.string() }, async execute(input) { return input.value } })
const permission: Permission = { id: "p", type: "read", sessionID: "s", messageID: "m", title: "Read", metadata: {}, time: { created: 0 } }
const plugin: Plugin = async (input) => { await input.client.auth.set({ path: { id: "fixture" }, body: { type: "api", key: "fixture" } }); return {} }
export { definition, permission, plugin }
`,
    "tool.ts":
      'import { tool, type ToolDefinition } from "@vectordevai/plugin/tool"\nexport const definition: ToolDefinition = tool({ description: "fixture", args: {}, async execute() { return "ok" } })\n',
    "tui.ts":
      'import { createBindingLookup, type TuiRouteCurrent } from "@vectordevai/plugin/tui"\nexport const route: TuiRouteCurrent = { name: "home" }\nexport { createBindingLookup }\n',
    "effect.ts":
      'import { define, type PluginContext } from "@vectordevai/plugin/v2/effect"\nimport { Effect } from "effect"\nexport const plugin = define({ id: "fixture", effect: (_context: PluginContext) => Effect.void })\n',
    "integration.ts":
      'import type { IntegrationDraft } from "@vectordevai/plugin/v2/effect/integration"\nexport function identity(value: IntegrationDraft) { return value }\n',
    "effect-plugin.ts":
      'import { define } from "@vectordevai/plugin/v2/effect/plugin"\nimport { Effect } from "effect"\nexport const plugin = define({ id: "fixture", effect: () => Effect.void })\n',
    "promise.ts":
      'import { define, type PluginContext } from "@vectordevai/plugin/v2/promise"\nexport const plugin = define({ id: "fixture", setup: async (_context: PluginContext) => {} })\n',
  }
  for (const [name, source] of Object.entries(sources)) await Bun.write(path.join(consumer, name), source)
  await run([process.execPath, "typecheck"])
  // Check our declarations as well, while reporting separately errors owned by installed upstream libraries.
  await Bun.write(
    path.join(consumer, "declarations.mjs"),
    `import ts from "typescript"
import path from "node:path"
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, skipLibCheck: false })
const diagnostics = ts.getPreEmitDiagnostics(program)
const owned = diagnostics.filter((item) => !item.file || !item.file.fileName.includes("/node_modules/") || item.file.fileName.includes("/node_modules/@vectordevai/plugin/"))
const report = (items) => items.map((item) => ({ file: item.file ? path.relative(process.cwd(), item.file.fileName) : undefined, code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, "\\n") }))
if (owned.length) { console.error(JSON.stringify(report(owned), null, 2)); process.exit(1) }
console.log(JSON.stringify(report(diagnostics)))
`,
  )
  const upstreamDeclarationDiagnostics = JSON.parse(await run([process.execPath, "declarations.mjs"]))
  await Bun.write(
    path.join(consumer, "smoke.mjs"),
    [
      'import assert from "node:assert/strict"',
      'const root = await import("@vectordevai/plugin")',
      'assert.equal(typeof root.tool, "function")',
      ...Object.keys(manifest.exports as Record<string, unknown>)
        .filter((name) => name !== ".")
        .map((name) => `await import(${JSON.stringify(`@vectordevai/plugin${name.slice(1)}`)})`),
      'console.log("Packed plugin: every export imports successfully")',
    ].join("\n"),
  )
  await run([process.execPath, "smoke.mjs"])
  console.log(
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        tarball: packed.filename,
        exports: Object.keys(manifest.exports),
        privateSdkInstalled: false,
        workspaceSymlinks: false,
        typecheck: "passed",
        packedDeclarations: "passed",
        upstreamDeclarationDiagnostics,
        runtime: "passed",
        notices: "identical",
      },
      null,
      2,
    ),
  )
} finally {
  await rm(consumer, { recursive: true, force: true })
}
