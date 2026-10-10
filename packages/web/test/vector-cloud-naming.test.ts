import { expect, test } from "bun:test"
import path from "node:path"

// The docs describe the screens the app shows: Vector Cloud, and Connections
// for the accounts. The page keeps its /docs/cloud-services URL for old links.
// Release notes are history and keep the name they shipped with.
const OLD_NAMES = /Cloud [Ss]ervices|(?:>|→)\s*Integrations\b/

test("the docs and landing page never call it Cloud Services or send people to Integrations", async () => {
  const root = path.join(import.meta.dir, "../src")
  const files = [
    ...(await Array.fromAsync(new Bun.Glob("pages/docs/**/*.{astro,md,mdx}").scan({ cwd: root }))),
    ...(await Array.fromAsync(new Bun.Glob("components/**/*.astro").scan({ cwd: root }))),
    "data/docs-nav.ts",
  ]
  const texts = await Promise.all(
    files.map(async (file) => ({ file, text: await Bun.file(path.join(root, file)).text() })),
  )
  expect(files).toContain("pages/docs/cloud-services.astro")
  expect(texts.filter((item) => OLD_NAMES.test(item.text)).map((item) => item.file)).toEqual([])
})
