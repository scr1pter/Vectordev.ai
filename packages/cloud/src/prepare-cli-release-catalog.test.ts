import { expect, test } from "bun:test"
import path from "node:path"
import { cliReleaseFixture } from "./cli-release-fixture"
import { cliReleaseInputs, prepareCliReleaseCatalog } from "./prepare-cli-release-catalog"

test("release entrypoint pins every identity field and rejects missing or unsafe inputs", async () => {
  await using fixture = await cliReleaseFixture()
  const env = {
    VECTOR_RELEASE_VERSION: fixture.input.version,
    VECTOR_RELEASE_CHANNEL: fixture.input.channel,
    VECTOR_CLI_BLOB_ORIGIN: fixture.input.origin,
    VECTOR_SOURCE_REVISION: fixture.input.sourceRevision,
    VECTOR_CATALOG_SHA256: fixture.input.catalogSha256,
    VECTOR_RELEASE_PUBLISHED_AT: fixture.input.publishedAt,
  }
  expect(cliReleaseInputs(env)).toEqual({
    version: fixture.input.version,
    channel: fixture.input.channel,
    origin: fixture.input.origin,
    sourceRevision: fixture.input.sourceRevision,
    catalogSha256: fixture.input.catalogSha256,
    publishedAt: fixture.input.publishedAt,
  })
  for (const name of Object.keys(env)) expect(() => cliReleaseInputs({ ...env, [name]: undefined })).toThrow()
  for (const origin of [
    "http://127.0.0.1",
    "https://example.com",
    `${fixture.input.origin}/path`,
    `${fixture.input.origin}?query=x`,
  ])
    expect(() => cliReleaseInputs({ ...env, VECTOR_CLI_BLOB_ORIGIN: origin })).toThrow()
  expect(() => cliReleaseInputs({ ...env, VECTOR_RELEASE_VERSION: "1.99.123-beta.1" })).toThrow("prerelease")
})

test("catalog preparation fetches only the immutable version and preserves the exact reviewed bytes", async () => {
  await using fixture = await cliReleaseFixture()
  const text = await Bun.file(path.join(fixture.input.source, "api.json")).text()
  const requests: Array<{ pathname: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ pathname: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
      return new Response(text)
    },
  })
  try {
    const output = path.join(fixture.root, "prepared/api.json")
    await prepareCliReleaseCatalog({
      release: fixture.input,
      output,
      request: (url, init) => {
        expect(url).toBe(`${fixture.input.origin}/releases/vector-v${fixture.input.version}/api.json`)
        expect(init.redirect).toBe("error")
        return fetch(new URL(new URL(url).pathname, server.url), init)
      },
    })
    expect(await Bun.file(output).text()).toBe(text)
    expect(requests).toEqual([{ pathname: `/releases/vector-v${fixture.input.version}/api.json`, authorization: null }])
  } finally {
    await server.stop(true)
  }
})

test.each(["missing", "changed", "redirect", "oversized"])(
  "catalog %s response cannot produce build input",
  async (mode) => {
    await using fixture = await cliReleaseFixture()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        if (mode === "missing") return new Response(null, { status: 404 })
        if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "/other" } })
        return new Response(mode === "oversized" ? new Uint8Array(32_000_001) : "different catalog")
      },
    })
    try {
      const output = path.join(fixture.root, "must-not-exist.json")
      await expect(
        prepareCliReleaseCatalog({ release: fixture.input, output, request: (_url, init) => fetch(server.url, init) }),
      ).rejects.toThrow()
      expect(await Bun.file(output).exists()).toBe(false)
    } finally {
      await server.stop(true)
    }
  },
)
