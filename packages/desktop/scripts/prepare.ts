#!/usr/bin/env bun
import { stampDesktopVersion } from "./build-identity"
import { Script } from "@vectordevai/script"

await import("./prebuild")

const pkg = await Bun.file("./package.json").json()
await Bun.write(
  "./package.json",
  JSON.stringify(stampDesktopVersion(pkg, Script.version, Bun.env.VECTOR_REQUIRED_CLI_VERSION), null, 2) + "\n",
)
console.log(`Updated package.json version to ${Script.version}`)
