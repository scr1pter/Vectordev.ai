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

test("both public catalog aliases rewrite to the owned Blob mirror", async () => {
  const config = await Bun.file(new URL("../../../../vercel.json", import.meta.url)).json()
  for (const source of ["/models", "/models/api.json"]) {
    expect(config.rewrites.find((rule: { source: string }) => rule.source === source)).toEqual({
      source,
      destination: "https://42qryducihx01gl0.public.blob.vercel-storage.com/models/api.json",
    })
  }
})
