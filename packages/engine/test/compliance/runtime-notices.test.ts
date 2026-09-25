import { expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"

const root = path.resolve(import.meta.dir, "../../../..")
const directory = path.join(root, "licenses/bun")
const manifest = await Bun.file(path.join(directory, "manifest.json")).json()
const notices = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()

test("runtime notices match the pinned Bun release and its recorded WebKit source", async () => {
  const pkg = await Bun.file(path.join(root, "package.json")).json()
  expect(pkg.packageManager).toBe(`bun@${manifest.bunVersion}`)
  expect(manifest.bunTag).toBe(`bun-v${manifest.bunVersion}`)
  expect(notices).toContain(`Bun v${manifest.bunVersion}`)
  expect(notices).toContain(manifest.bunTagUrl)
  const source = await Bun.file(path.join(directory, "provenance/webkit.ts")).text()
  expect(source.match(/WEBKIT_VERSION = "([a-f0-9]+)"/)?.[1]).toBe(manifest.webkitCommit)
  expect(notices).toContain(`https://github.com/oven-sh/WebKit/tree/${manifest.webkitCommit}`)
})

test("the shipped notice file contains every complete recorded runtime license text", async () => {
  const components = new Set(manifest.licenses.map((entry: { name: string }) => entry.name))
  for (const name of [
    "bun-mit-template",
    "boringssl",
    "brotli",
    "libarchive",
    "lolhtml",
    "lshpack",
    "lsqpack",
    "lsquic",
    "mimalloc",
    "picohttpparser",
    "zstd",
    "simdutf",
    "tinycc",
    "usockets",
    "zlib",
    "cares",
    "icu-webkit",
    "icu-windows",
    "libbase64",
    "libuv",
    "libdeflate",
    "libjpeg-turbo",
    "libspng",
    "libwebp",
    "highway",
    "uucode",
    "uwebsockets",
    "tigerbeetle",
    "llvm-libcxxabi",
    "webkit",
    "hdrhistogram",
    "sqlite",
    "cline",
    "gemini",
  ])
    expect(components.has(name), `Missing component: ${name}`).toBe(true)
  for (const entry of manifest.licenses) {
    const text = await Bun.file(path.join(directory, entry.file)).text()
    expect(createHash("sha256").update(text).digest("hex"), entry.file).toBe(entry.sha256)
    expect(Buffer.byteLength(text), entry.file).toBe(entry.bytes)
    expect(notices, `The installer notice omits ${entry.file}`).toContain(text.trimEnd())
    expect(notices).toContain(entry.url)
    expect(entry.url).not.toContain("/main/")
    expect(entry.url).not.toContain("/master/")
  }
  expect(notices).toContain("Copyright 2025 Cline Bot Inc.")
  expect(notices).toContain("Copyright 2025 Google LLC")
  expect(notices).toContain("Version 2.0, January 2004")
  expect(notices).toContain("GNU LESSER GENERAL PUBLIC LICENSE")
  expect(notices).toContain("PNG Reference Library License version 2")
})

test("dependency-pin evidence remains intact and does not claim an unverified libbase64 object revision", async () => {
  for (const entry of manifest.provenance) {
    const bytes = await Bun.file(path.join(directory, entry.file)).arrayBuffer()
    expect(createHash("sha256").update(Buffer.from(bytes)).digest("hex"), entry.file).toBe(entry.sha256)
    expect(entry.url).not.toContain("/main/")
    expect(entry.url).not.toContain("/master/")
  }
  expect(notices).toContain("not a claim about the linked object revision")
  expect(notices).toContain("without inventing a copyright holder/year")
  expect(notices.indexOf("<!-- vector-upstream-attribution -->")).toBeLessThan(notices.indexOf("## Bun runtime"))
})
