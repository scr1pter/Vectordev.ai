import { expect, test } from "bun:test"
import path from "node:path"

test("build, runtime and release catalog paths have no live dependency on the original data service", async () => {
  const root = path.resolve(import.meta.dirname, "../../../..")
  const files = [
    "packages/core/src/model-catalog.ts",
    "packages/engine/script/release-catalog.ts",
    "packages/engine/script/generate.ts",
    "packages/cloud/src/upload-model-catalog.ts",
    ".github/workflows/vector-desktop-release.yml",
  ]
  for (const file of files) expect(await Bun.file(path.join(root, file)).text(), file).not.toMatch(/models\.dev/i)
  const workflow = await Bun.file(path.join(root, files[4])).text()
  expect(workflow).toContain("VECTOR_CATALOG_FORK_REPOSITORY")
  expect(workflow).toContain("VECTOR_CATALOG_FORK_REVISION")
  expect(workflow).toContain("provider-catalog-icons.ts")
  expect(workflow).toContain("verify-catalog-mirror.ts")
})

test("both public catalog aliases serve the committed catalog from vectordev.ai itself", async () => {
  const root = path.resolve(import.meta.dirname, "../../../..")
  const config = await Bun.file(path.join(root, "vercel.json")).json()
  // /models/api.json is the static file itself (Vercel serves files before rewrites); /models aliases it.
  expect(config.rewrites.find((rule: { source: string }) => rule.source === "/models/api.json")).toBeUndefined()
  expect(config.rewrites.find((rule: { source: string }) => rule.source === "/models")).toEqual({
    source: "/models",
    destination: "/models/api.json",
  })
  const catalog = await Bun.file(path.join(root, "packages/web/public/models/api.json")).json()
  expect(Object.keys(catalog.openai.models)).toEqual(expect.arrayContaining(["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol"]))
  expect(await Bun.file(path.join(root, "script/prune-vector-site.mjs")).text()).toContain('"models"')
})
