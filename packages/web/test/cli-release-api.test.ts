import { afterAll, beforeAll, expect, test } from "bun:test"
import { createServer } from "node:http"
import { CliRelease } from "@vectordevai/schema/cli-release"
import { readCliManifest } from "../../../api/_lib/cli-release"
import { handleCliRelease } from "../../../api/cli-release"

const origin = "https://fixture.public.blob.vercel-storage.com"
const fixture = CliRelease.decode(
  {
    schemaVersion: 1,
    version: "1.2.3",
    channel: "latest",
    publishedAt: "2026-09-25T00:00:00.000Z",
    sourceRevision: "a".repeat(40),
    catalogSha256: "b".repeat(64),
    targets: Object.fromEntries(
      CliRelease.targets.map((target) => [
        target,
        {
          filename: CliRelease.filename(target),
          pathname: CliRelease.archivePath("1.2.3", target),
          url: `${origin}/${CliRelease.archivePath("1.2.3", target)}`,
          size: 123,
          sha256: "c".repeat(64),
        },
      ]),
    ),
  },
  origin,
)
const requests: string[] = []
const server = createServer(
  (request, response) =>
    void handleCliRelease(request, response, async (version) => {
      requests.push(version)
      return readCliManifest(
        new Response(JSON.stringify(fixture)).body!,
        `${origin}/${CliRelease.manifestPath(version)}`,
        version,
      )
    }),
)
const state = { origin: "" }
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  state.origin = `http://127.0.0.1:${address.port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

test("public metadata serves complete JSON and exact shell-safe target rows", async () => {
  const manifest = await fetch(state.origin)
  expect(manifest.status).toBe(200)
  expect(manifest.headers.get("cache-control")).toBe("no-store")
  expect(manifest.headers.get("x-vector-release")).toBe("1.2.3")
  expect(await manifest.json()).toEqual(fixture)
  for (const target of CliRelease.targets) {
    const selected = CliRelease.select(fixture, target)
    const json = await fetch(`${state.origin}/?version=1.2.3&target=${target}`)
    expect(await json.json()).toEqual(selected)
    const tsv = await fetch(`${state.origin}/?target=${target}&format=tsv`)
    expect(tsv.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await tsv.text()).toBe(CliRelease.tsv(selected))
  }
})

test("invalid and duplicate inputs never reach storage", async () => {
  const before = requests.length
  for (const query of [
    "version=../x",
    "target=linux-mips",
    "format=tsv",
    "format=xml",
    "version=latest&version=1.2.3",
    "target=linux-x64&target=linux-arm64",
    "version=1.2.3%0Ax",
  ]) {
    const response = await fetch(`${state.origin}/?${query}`)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("CLI_RELEASE_QUERY")
  }
  const method = await fetch(state.origin, { method: "POST" })
  expect(method.status).toBe(405)
  await method.text()
  expect(requests.length).toBe(before)
})

test("storage decoding rejects wrong versions, channels, origins, paths and oversized streams", async () => {
  for (const [body, url, version] of [
    [JSON.stringify(fixture), `${origin}/${CliRelease.manifestPath("1.2.4")}`, "1.2.4"],
    [JSON.stringify(fixture), `${origin}/${CliRelease.manifestPath("beta")}`, "beta"],
    [JSON.stringify(fixture), `https://other.public.blob.vercel-storage.com/${CliRelease.manifestPath()}`, "latest"],
    [JSON.stringify(fixture), `${origin}/${CliRelease.manifestPath()}?token=fixture`, "latest"],
    ["not JSON", `${origin}/${CliRelease.manifestPath()}`, "latest"],
    [" ".repeat(CliRelease.MAX_MANIFEST_BYTES + 1), `${origin}/${CliRelease.manifestPath()}`, "latest"],
  ])
    await expect(readCliManifest(new Response(body).body!, url!, version!)).rejects.toMatchObject({
      statusCode: 503,
      code: "CLI_RELEASE_INVALID",
    })
  expect(
    await readCliManifest(
      new Response(JSON.stringify(fixture)).body!,
      `${origin}/${CliRelease.manifestPath()}`,
      "latest",
    ),
  ).toEqual(fixture)
})
