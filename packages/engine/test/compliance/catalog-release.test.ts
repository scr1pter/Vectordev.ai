import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { catalogBody, catalogDigest, ensurePublishedCatalog, prepareReleaseCatalog } from "../../script/release-catalog"
import { ModelCatalog } from "@vectordevai/schema/model-catalog"
import { catalogForkFixture } from "../fixture/catalog-fork"

const script = path.resolve(import.meta.dirname, "../../script/generate.ts")
const provider = {
  id: "anthropic",
  name: "Anthropic",
  env: ["ANTHROPIC_API_KEY"],
  npm: "@ai-sdk/anthropic",
  models: {},
}

async function fixture(input: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vector-catalog-release-"))
  const text = JSON.stringify(input)
  await Bun.write(path.join(dir, "input.json"), text)
  return { dir, sha256: catalogDigest(text), [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

async function generate(dir: string, env: Record<string, string | undefined>, args: string[] = []) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, "home"),
      VECTOR_RELEASE_CATALOG_PATH: "input.json",
      VECTOR_CATALOG_FILE: "api.json",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("pinned catalogs ignore runtime overrides and replay identically for CLI and desktop", async () => {
  await using tmp = await fixture(JSON.parse(catalogBody(JSON.stringify({ anthropic: provider }))))
  const prepared = await generate(tmp.dir, {
    VECTOR_RELEASE_CATALOG_SHA256: tmp.sha256,
    VECTOR_MODELS_PATH: "does-not-exist.json",
    VECTOR_MODELS_SHA256: "ignored",
  })
  expect(prepared.code, prepared.stderr).toBe(0)
  const snapshot = await Bun.file(path.join(tmp.dir, "api.json")).text()
  expect(JSON.parse(snapshot)).toEqual({ anthropic: provider })
  expect(prepared.stdout).toContain(path.join(tmp.dir, "input.json"))
  expect(prepared.stdout).toContain(tmp.sha256)
  expect(prepared.stdout).toContain(catalogDigest(snapshot))
  for (const target of ["cli", "desktop"]) {
    const replayed = await generate(tmp.dir, {
      VECTOR_RELEASE_CATALOG_PATH: "api.json",
      VECTOR_CATALOG_FILE: `${target}.json`,
      VECTOR_RELEASE_CATALOG_SHA256: catalogDigest(snapshot),
    })
    expect(replayed.code, replayed.stderr).toBe(0)
    expect(await Bun.file(path.join(tmp.dir, `${target}.json`)).text()).toBe(snapshot)
  }
})

test("changed, missing, and unpinned catalogs fail without an implicit refresh", async () => {
  await using tmp = await fixture({ anthropic: provider })
  await Bun.write(path.join(tmp.dir, "input.json"), JSON.stringify({ changed: {} }))
  const changed = await generate(tmp.dir, { VECTOR_RELEASE_CATALOG_SHA256: tmp.sha256 })
  expect(changed.code).not.toBe(0)
  expect(changed.stderr).toContain("digest does not match")
  for (const env of [
    { VECTOR_RELEASE_CATALOG_PATH: "", VECTOR_RELEASE_CATALOG_SHA256: tmp.sha256 },
    { VECTOR_RELEASE_CATALOG_PATH: "", VECTOR_MODELS_PATH: "input.json" },
    {},
  ]) {
    const result = await generate(tmp.dir, env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("VECTOR_RELEASE_CATALOG")
  }
  expect(await Bun.file(path.join(tmp.dir, "api.json")).exists()).toBe(false)
})

for (const input of [
  {},
  [],
  { "unsupported-fixture": { ...provider, id: "unsupported-fixture" } },
  { anthropic: { ...provider, models: { invalid: {} } } },
  { anthropic: { ...provider, npm: "unreviewed-package" } },
]) {
  test(`refuses invalid release catalog ${JSON.stringify(input)}`, async () => {
    await using tmp = await fixture(input)
    const result = await generate(tmp.dir, { VECTOR_RELEASE_CATALOG_SHA256: tmp.sha256 })
    expect(result.code).not.toBe(0)
    expect(await Bun.file(path.join(tmp.dir, "api.json")).exists()).toBe(false)
  })
}

test("SDK catalog allowlist matches the actual bundled engine loaders", async () => {
  const source = await Bun.file(new URL("../../src/provider/provider.ts", import.meta.url)).text()
  const block = source.slice(source.indexOf("const BUNDLED_PROVIDERS:"), source.indexOf("type CustomModelLoader"))
  const packages = Array.from(block.matchAll(/^  "([^"]+)":/gm), (match) => match[1]).sort()
  expect(packages).toEqual([...ModelCatalog.BUNDLED_PROVIDER_PACKAGES].sort())
})

test("only explicit fresh preparation removes unbundled SDKs", () => {
  const catalog = JSON.stringify({
    anthropic: provider,
    openai: { ...provider, id: "openai", npm: "unreviewed-package" },
  })
  expect(() => catalogBody(catalog)).toThrow("unbundled SDK")
  expect(JSON.parse(catalogBody(catalog, true))).toEqual({ anthropic: provider })
})

for (const status of [200, 404, 503]) {
  for (const fresh of [false, true]) {
    test(`CLI preparation uses immutable mirror HTTP ${status}, fresh=${fresh}`, async () => {
      await using tmp = await fixture({ anthropic: provider })
      await using fork = await catalogForkFixture({ "vector/api.json": JSON.stringify({ anthropic: provider }) })
      const requests: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const pathname = new URL(request.url).pathname
          requests.push(pathname)
          return new Response(catalogBody(JSON.stringify({ anthropic: provider })), {
            status: pathname === "/api.json" ? 200 : status,
          })
        },
      })
      try {
        const prepared = prepareReleaseCatalog({
          version: "1.99.123",
          directory: tmp.dir,
          fresh,
          fork: fork.input,
          request: (url, init) => fetch(new URL(new URL(url).pathname, server.url), init),
        })
        if (status === 200 || (status === 404 && fresh)) {
          const result = await prepared
          const text = await Bun.file(result.file).text()
          expect(result.sha256).toBe(catalogDigest(text))
          expect(JSON.parse(text)).toEqual({ anthropic: provider })
          expect(requests).toEqual(["/releases/vector-v1.99.123/api.json"])
          return
        }
        await expect(prepared).rejects.toThrow(status === 404 ? "--fresh-catalog" : "HTTP 503")
        expect(requests).toEqual(["/releases/vector-v1.99.123/api.json"])
        expect(await Bun.file(path.join(tmp.dir, "api.json")).exists()).toBe(false)
      } finally {
        await server.stop(true)
      }
    })
  }
}

test("CLI accepts the exact workflow artifact before its mirror exists", async () => {
  await using tmp = await fixture({ anthropic: provider })
  const text = catalogBody(await Bun.file(path.join(tmp.dir, "input.json")).text())
  const file = path.join(tmp.dir, "reviewed.json")
  await Bun.write(file, text)
  const requests: string[] = []
  const request = async (url: string) => {
    requests.push(url)
    throw new Error("Network must not be used for a supplied artifact")
  }
  const result = await prepareReleaseCatalog({
    version: "1.99.123",
    directory: tmp.dir,
    file,
    sha256: catalogDigest(text),
    request,
  })
  expect(result).toEqual({ file, sha256: catalogDigest(text) })
  expect(requests).toEqual([])
  await expect(
    prepareReleaseCatalog({ version: "1.99.123", directory: tmp.dir, file, sha256: "changed", request }),
  ).rejects.toThrow("digest does not match")
  await expect(prepareReleaseCatalog({ version: "1.99.123", directory: tmp.dir, file, request })).rejects.toThrow(
    "requires both",
  )
})

test("fresh preparation requires the pinned fork and never blesses arbitrary supplied JSON", async () => {
  await using tmp = await fixture({
    anthropic: provider,
    openai: { ...provider, id: "openai", npm: "unreviewed-package" },
  })
  const pinned = await generate(tmp.dir, { VECTOR_RELEASE_CATALOG_SHA256: tmp.sha256 })
  expect(pinned.code).not.toBe(0)
  const supplied = await generate(tmp.dir, { VECTOR_RELEASE_CATALOG_SHA256: tmp.sha256 }, ["--fresh-catalog"])
  expect(supplied.code).not.toBe(0)
  expect(supplied.stderr).toContain("Fresh catalogs must come from the pinned Vector fork")
  const missing = await generate(tmp.dir, { VECTOR_RELEASE_CATALOG_PATH: "" }, ["--fresh-catalog"])
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("there is no external catalog fallback")
  await using fork = await catalogForkFixture({
    "vector/api.json": await Bun.file(path.join(tmp.dir, "input.json")).text(),
  })
  const prepared = await generate(
    tmp.dir,
    {
      VECTOR_RELEASE_CATALOG_PATH: "",
      VECTOR_CATALOG_FORK_PATH: fork.input.directory,
      VECTOR_CATALOG_FORK_REPOSITORY: fork.input.repository,
      VECTOR_CATALOG_FORK_REVISION: fork.input.revision,
    },
    ["--fresh-catalog"],
  )
  expect(prepared.code, prepared.stderr).toBe(0)
  expect(prepared.stderr).toContain("Omitting catalog provider openai")
  expect(JSON.parse(await Bun.file(path.join(tmp.dir, "api.json")).text())).toEqual({ anthropic: provider })
  expect(await Bun.file(path.join(tmp.dir, "api.json.provenance.json")).json()).toMatchObject({
    repository: fork.input.repository,
    revision: fork.input.revision,
  })
})

test("an existing mirror cannot be normalized into a different release artifact", async () => {
  await using tmp = await fixture({ anthropic: provider })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(JSON.stringify({ anthropic: provider }, null, 2)),
  })
  try {
    await expect(
      prepareReleaseCatalog({
        version: "1.99.123",
        directory: tmp.dir,
        request: (_url, init) => fetch(server.url, init),
      }),
    ).rejects.toThrow("refusing to change its content")
    expect(await Bun.file(path.join(tmp.dir, "api.json")).exists()).toBe(false)
  } finally {
    await server.stop(true)
  }
})

for (const result of ["same", "missing", "different", "failed"] as const) {
  test(`CLI publication requires its immutable catalog: ${result}`, async () => {
    await using tmp = await fixture({ anthropic: provider })
    const file = path.join(tmp.dir, "input.json")
    const body = await Bun.file(file).text()
    const uploads: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(result === "same" ? body : "different", {
          status: result === "missing" ? 404 : result === "failed" ? 503 : 200,
        }),
    })
    try {
      const publication = ensurePublishedCatalog({
        version: "1.99.123",
        file,
        upload: async () => {
          uploads.push("catalog")
        },
        request: (_url, init) => fetch(server.url, init),
      })
      if (result === "failed" || result === "different") {
        await expect(publication).rejects.toThrow("publication stopped")
        expect(uploads).toEqual([])
        return
      }
      await publication
      expect(uploads).toEqual(result === "missing" ? ["catalog"] : [])
    } finally {
      await server.stop(true)
    }
  })
}

test("reviewed V3 SDKs survive catalog preparation and old SAP package identities normalize", () => {
  const packages = {
    "cloudflare-ai-gateway": "ai-gateway-provider",
    "sap-ai-core": "@jerome-benoit/sap-ai-provider-v2",
    aihubmix: "@aihubmix/ai-sdk-provider",
    "merge-gateway": "merge-gateway-ai-sdk-provider",
    watsonx: "watsonx-ai-provider",
    qvac: "@qvac/ai-sdk-provider",
    "salad-cloud": "@saladtechnologies/ai-sdk-provider",
  }
  const input = Object.fromEntries(
    Object.entries(packages).map(([id, npm]) => [
      id,
      { ...provider, id, npm, ...(id === "qvac" ? { api: "http://127.0.0.1:11435/v1" } : {}) },
    ]),
  )
  const result = JSON.parse(catalogBody(JSON.stringify(input), true))
  expect(Object.keys(result)).toHaveLength(6)
  expect(result["sap-ai-core"].npm).toBe("@jerome-benoit/sap-ai-provider")
  expect(result["salad-cloud"]).toBeUndefined()
  expect(result.qvac.api).toBeUndefined()
  expect(ModelCatalog.packageAllowed("@saladtechnologies/ai-sdk-provider")).toBe(false)
  expect(ModelCatalog.packageAllowed("@jerome-benoit/sap-ai-provider-v2")).toBe(false)
  expect(ModelCatalog.decodeCatalog({ "sap-ai-core": input["sap-ai-core"] })["sap-ai-core"].npm).toBe(
    "@jerome-benoit/sap-ai-provider",
  )
})
