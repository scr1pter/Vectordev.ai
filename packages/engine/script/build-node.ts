#!/usr/bin/env bun

import { Script } from "@vectordevai/script"
import path from "path"
import { fileURLToPath } from "url"
import pluginPkg from "../../plugin/package.json"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    VECTOR_MODEL_CATALOG: generated.modelsData,
    VECTOR_CHANNEL: `'${Script.channel}'`,
    VECTOR_VERSION: `'${Script.version}'`,
    VECTOR_PLUGIN_VERSION: `'${pluginPkg.version}'`,
  },
  files: {
    "vector-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
