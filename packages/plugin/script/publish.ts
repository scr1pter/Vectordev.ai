#!/usr/bin/env bun
import { $ } from "bun"
import path from "node:path"
import { stagePlugin, verifyPlugin } from "./build"

const directory = path.resolve(import.meta.dirname, "..")
const publish = process.argv.includes("--publish")
const dryRun = process.argv.includes("--dry-run")
if (publish && dryRun) throw new Error("Choose --publish or --dry-run, not both")
const output = process.argv.includes("--skip-build")
  ? path.join(directory, "dist-publish")
  : await stagePlugin(directory)
await verifyPlugin(output)
const manifest = await Bun.file(path.join(output, "package.json")).json()

if (!publish) {
  await $`npm pack --offline --json`.cwd(output)
  console.log(`Packed ${manifest.name}@${manifest.version}; nothing was published`)
} else {
  const existing = await $`npm view ${`${manifest.name}@${manifest.version}`} version`.quiet().nothrow()
  if (existing.exitCode === 0) console.log(`already published ${manifest.name}@${manifest.version}`)
  else await $`npm publish --access public`.cwd(output)
}
