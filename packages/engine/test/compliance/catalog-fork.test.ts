import { expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import path from "node:path"
import { catalogFork } from "../../script/catalog-fork"
import { catalogDigest, freshCatalog } from "../../script/release-catalog"
import { catalogForkFixture } from "../fixture/catalog-fork"

const catalog = JSON.stringify({ anthropic: { id: "anthropic", name: "Anthropic", env: [], models: {} } })

test("fresh preparation reads only a regular committed export at the owner-confirmed revision", async () => {
  await using fixture = await catalogForkFixture({ "vector/api.json": catalog })
  const prepared = await freshCatalog(fixture.input)
  expect(JSON.parse(prepared.text).anthropic.id).toBe("anthropic")
  expect(prepared.provenance).toEqual({
    repository: fixture.input.repository,
    revision: fixture.input.revision,
    path: "vector/api.json",
    sourceSha256: catalogDigest(catalog),
    sha256: catalogDigest(prepared.text),
  })
  const fork = await catalogFork(fixture.input)
  await expect(fork.read("../outside.json")).rejects.toThrow("relative data paths")
  await expect(fork.read("missing.json")).rejects.toThrow("regular committed")
})

test("fresh preparation fails closed without owner configuration or when origin, revision, or tracked export changes", async () => {
  await expect(catalogFork({ directory: undefined, repository: undefined, revision: undefined })).rejects.toThrow(
    "there is no external catalog fallback",
  )
  await using fixture = await catalogForkFixture({ "vector/api.json": catalog })
  await expect(catalogFork({ ...fixture.input, repository: "other/catalog" })).rejects.toThrow("origin")
  await expect(catalogFork({ ...fixture.input, revision: "a".repeat(40) })).rejects.toThrow("HEAD")
  await Bun.write(path.join(fixture.input.directory, "vector/api.json"), "modified")
  await expect(freshCatalog(fixture.input)).rejects.toThrow("modified tracked files")
})

test("fork data never follows a committed symlink to a local file", async () => {
  await using fixture = await catalogForkFixture({ "payload.json": catalog })
  await symlink("payload.json", path.join(fixture.input.directory, "api.json"))
  await fixture.git(["add", "api.json"])
  await fixture.git(["commit", "--quiet", "-m", "symlink"])
  const fork = await catalogFork({ ...fixture.input, revision: await fixture.git(["rev-parse", "HEAD"]) })
  await expect(fork.read("api.json")).rejects.toThrow("regular committed")
})

test("committed text bytes are never silently repaired before their provenance digest", async () => {
  await using fixture = await catalogForkFixture({ "vector/api.json": catalog })
  await Bun.write(path.join(fixture.input.directory, "invalid.json"), new Uint8Array([0xff]))
  await Bun.write(path.join(fixture.input.directory, "bom.json"), `\uFEFF${catalog}`)
  await fixture.git(["add", "."])
  await fixture.git(["commit", "--quiet", "-m", "byte fixtures"])
  const fork = await catalogFork({ ...fixture.input, revision: await fixture.git(["rev-parse", "HEAD"]) })
  await expect(fork.read("invalid.json")).rejects.toThrow()
  expect(await fork.read("bom.json")).toBe(`\uFEFF${catalog}`)
})
