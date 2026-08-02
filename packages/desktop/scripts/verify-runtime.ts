#!/usr/bin/env bun

const files = Array.from(new Bun.Glob("out/main/**/*.js").scanSync(import.meta.dir + "/.."))
const output = await Promise.all(files.map((file) => Bun.file(import.meta.dir + `/../${file}`).text()))
const bundled = output.join("\n")

if (!bundled.includes('"@lydell/node-pty"')) {
  throw new Error("Desktop build does not reference the platform-neutral PTY loader.")
}

const platformSpecific = bundled.match(/@lydell\/node-pty-(?:darwin|linux|win32)-(?:arm64|x64)/g)
if (platformSpecific?.length) {
  throw new Error(`Desktop build is pinned to the build machine: ${[...new Set(platformSpecific)].join(", ")}`)
}

console.log("verified platform-neutral desktop runtime")
