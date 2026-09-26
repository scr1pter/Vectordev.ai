#!/usr/bin/env bun
import path from "node:path"
import { $ } from "bun"
import { stageSdk, verifySdk } from "./stage"

const directory = path.resolve(import.meta.dirname, "..")
const publish = process.argv.includes("--publish")
if (publish && process.argv.includes("--dry-run")) throw new Error("Choose --publish or --dry-run")
if (publish && process.env.VECTOR_SDK_PUBLISH_APPROVED !== "true")
  throw new Error(
    "Review the packed SDK and obtain first-publication and license approval before setting VECTOR_SDK_PUBLISH_APPROVED=true",
  )
const output = process.argv.includes("--skip-build") ? path.join(directory, "dist-publish") : await stageSdk()
await verifySdk(output)
const manifest = await Bun.file(path.join(output, "package.json")).json()
if (!publish) {
  await $`npm pack --offline --json`.cwd(output)
  console.log(`Packed ${manifest.name}@${manifest.version}; nothing published`)
}
if (publish) {
  const existing = await $`npm view ${`${manifest.name}@${manifest.version}`} version`.quiet().nothrow()
  if (existing.exitCode === 0)
    throw new Error("This SDK version already exists; compare its integrity instead of replacing it")
  const child = Bun.spawn(["npm", "publish", "--access", "public"], {
    cwd: output,
    stdio: ["inherit", "inherit", "inherit"],
  })
  if ((await child.exited) !== 0) throw new Error("SDK publication failed")
}
