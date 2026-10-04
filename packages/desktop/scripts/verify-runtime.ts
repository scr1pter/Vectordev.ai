#!/usr/bin/env bun

const desktopRoot = import.meta.dir + "/.."
const files = Array.from(new Bun.Glob("out/main/**/*.js").scanSync(desktopRoot))
const output = await Promise.all(files.map((file) => Bun.file(`${desktopRoot}/${file}`).text()))
const bundled = output.join("\n")

if (!bundled.includes('"@lydell/node-pty"')) {
  throw new Error("Desktop build does not reference the platform-neutral PTY loader.")
}

// @lydell/node-pty throws while loading when its platform package is missing or the wrong architecture. A static import
// runs that when the main process or the engine starts, so Vector would not open at all; load it inside the spawn paths.
const staticImport = bundled.match(/^\s*import\s[^;]*?["']@lydell\/node-pty["']/m)
if (staticImport) {
  throw new Error(`Desktop build loads @lydell/node-pty at startup: ${staticImport[0].trim()}`)
}

const platformSpecific = bundled.match(/@lydell\/node-pty-(?:darwin|linux|win32)-(?:arm64|x64)/g)
if (platformSpecific?.length) {
  throw new Error(`Desktop build is pinned to the build machine: ${[...new Set(platformSpecific)].join(", ")}`)
}

const rendererIndex = Bun.file(`${desktopRoot}/out/renderer/index.html`)
if (!(await rendererIndex.exists())) {
  throw new Error("Desktop build is missing out/renderer/index.html.")
}

const rendererHtml = await rendererIndex.text()
const localAssets = [...rendererHtml.matchAll(/(?:src|href)=["']\.\/([^"']+)["']/g)].map((match) => match[1])
const missingAssets: string[] = []

for (const asset of localAssets) {
  if (!(await Bun.file(`${desktopRoot}/out/renderer/${asset}`).exists())) missingAssets.push(asset)
}

if (missingAssets.length) {
  throw new Error(`Desktop renderer references missing assets: ${missingAssets.join(", ")}`)
}

console.log("verified platform-neutral desktop runtime and renderer entry")
