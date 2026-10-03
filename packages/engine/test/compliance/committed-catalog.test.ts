import { expect, test } from "bun:test"
import path from "node:path"
import { committedCatalog } from "../../script/committed-catalog"
import { catalogBody, catalogDigest } from "../../script/release-catalog"
import { catalogForkFixture } from "../fixture/catalog-fork"

const source = "packages/web/public/models/api.json"
const provider = { id: "openai", name: "OpenAI", env: [], npm: "@ai-sdk/openai", models: {} }
const text = catalogBody(JSON.stringify({ openai: provider }))

test("committed fallback pins exact application Git bytes despite a changed working copy", async () => {
  await using fixture = await catalogForkFixture({ [source]: text })
  await Bun.write(path.join(fixture.input.directory, source), "unreviewed working copy")
  const result = await committedCatalog({ directory: fixture.input.directory })
  expect(result).toEqual({
    text,
    provenance: {
      source: "application-git",
      revision: fixture.input.revision,
      path: source,
      sha256: catalogDigest(text),
    },
  })

  // Exercise the same pinned generator used by the workflow, including a mismatched digest refusal.
  await Bun.write(path.join(fixture.input.directory, "reviewed.json"), result.text)
  for (const sha256 of [result.provenance.sha256, "0".repeat(64)]) {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", path.resolve(import.meta.dirname, "../../script/generate.ts")],
      {
        cwd: fixture.input.directory,
        env: {
          PATH: process.env.PATH,
          HOME: fixture.input.directory,
          VECTOR_RELEASE_CATALOG_PATH: "reviewed.json",
          VECTOR_RELEASE_CATALOG_SHA256: sha256,
          VECTOR_CATALOG_FILE: `${sha256}.json`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (sha256 === result.provenance.sha256) {
      expect(code, stderr).toBe(0)
      expect(stdout).toContain(sha256)
      expect(await Bun.file(path.join(fixture.input.directory, `${sha256}.json`)).text()).toBe(text)
      continue
    }
    expect(code).not.toBe(0)
    expect(stderr).toContain("digest does not match")
    expect(await Bun.file(path.join(fixture.input.directory, `${sha256}.json`)).exists()).toBe(false)
  }
})

for (const variables of [
  { forkRepository: "owner/catalog" },
  { forkRevision: "a".repeat(40) },
  { forkRepository: "owner/catalog", forkRevision: "a".repeat(40) },
]) {
  test(`configured fork settings cannot silently use the committed fallback: ${JSON.stringify(variables)}`, async () => {
    await expect(committedCatalog({ directory: "must-not-read-git", ...variables })).rejects.toThrow(
      "both catalog fork variables to be unset",
    )
  })
}

test("missing committed data cannot be supplied by an untracked working-copy file", async () => {
  await using fixture = await catalogForkFixture({ "README.md": "fixture" })
  await Bun.write(path.join(fixture.input.directory, source), text)
  await expect(committedCatalog({ directory: fixture.input.directory })).rejects.toThrow("regular committed")
})

for (const mode of ["100755", "120000"]) {
  test(`committed fallback rejects a non-regular-data Git mode: ${mode}`, async () => {
    await using fixture = await catalogForkFixture({ [source]: text })
    const blob = await fixture.git(["rev-parse", `HEAD:${source}`])
    await fixture.git(["update-index", "--cacheinfo", `${mode},${blob},${source}`])
    await fixture.git(["commit", "--quiet", "-m", "non-data fixture"])
    await expect(committedCatalog({ directory: fixture.input.directory })).rejects.toThrow("regular committed")
  })
}

for (const invalid of [
  { name: "uncanonical bytes", text: JSON.stringify({ openai: provider }, null, 2), error: "not a prepared" },
  {
    name: "unreviewed SDK",
    text: JSON.stringify({ openai: { ...provider, npm: "unreviewed-sdk" } }),
    error: "unbundled SDK",
  },
  { name: "empty catalog", text: "{}", error: "nonempty provider object" },
]) {
  test(`committed fallback refuses ${invalid.name} instead of normalizing it`, async () => {
    await using fixture = await catalogForkFixture({ [source]: invalid.text })
    await expect(committedCatalog({ directory: fixture.input.directory })).rejects.toThrow(invalid.error)
  })
}

test("desktop workflow restricts the committed fallback and retains release gates", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(
      path.resolve(import.meta.dirname, "../../../../.github/workflows/vector-desktop-release.yml"),
    ).text(),
  ) as { jobs: { catalog: { steps: { name: string; run?: string; with?: { path?: string } }[] } } }
  const steps = workflow.jobs.catalog.steps
  const preparation = steps.find((step) => step.name === "Prepare the catalog once for every platform")?.run ?? ""
  expect(preparation).toContain("Set both catalog fork variables or leave both unset")
  expect(preparation).toContain(
    '404)\n    if [ -z "$VECTOR_CATALOG_FORK_REPOSITORY" ]; then\n      bun packages/engine/script/committed-catalog.ts',
  )
  expect(preparation).toContain(
    'if [ "$status" = "404" ] && [ -n "$VECTOR_CATALOG_FORK_REPOSITORY" ]; then\n  bun packages/engine/script/generate.ts --fresh-catalog',
  )
  expect(preparation).toContain("refusing to replace an unknown release snapshot")
  expect(steps.find((step) => step.name === "Require icons for every reviewed catalog provider")?.run).toContain(
    "provider-catalog-icons.ts",
  )
  expect(steps.find((step) => step.name === "Verify and expose the catalog digest")?.run).toContain(
    "sha256sum --check api.sha256",
  )
  expect(
    steps.find((step) => step.name === "Preserve the release catalog for builds and retries")?.with?.path,
  ).toContain("release-catalog")
})
