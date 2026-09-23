import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const script = path.resolve(import.meta.dirname, "../../script/generate.ts")

async function fixture(input: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vector-catalog-release-"))
  const text = JSON.stringify(input)
  await Bun.write(path.join(dir, "input.json"), text)
  return {
    dir,
    sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  }
}

async function generate(dir: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, script], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, "home"),
      VECTOR_MODELS_BUILD_URL: "http://127.0.0.1:1",
      VECTOR_MODELS_PATH: "input.json",
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

test("a pinned catalog uses caller-relative paths and replays byte-for-byte for every platform", async () => {
  await using tmp = await fixture({
    anthropic: { api: "https://api.anthropic.com/v1", models: { example: { name: "Example" } } },
    opencode: { api: "https://example.com" },
    "OpenCode-custom": { api: "https://example.com" },
    alias: { api: "https://api.opencode.ai/v1" },
  })
  const prepared = await generate(tmp.dir, { VECTOR_MODELS_SHA256: tmp.sha256 })
  expect(prepared.code, prepared.stderr).toBe(0)
  const snapshot = await Bun.file(path.join(tmp.dir, "api.json")).text()
  expect(JSON.parse(snapshot)).toEqual({
    anthropic: { api: "https://api.anthropic.com/v1", models: { example: { name: "Example" } } },
  })
  const replayed = await generate(tmp.dir, {
    VECTOR_MODELS_PATH: "api.json",
    VECTOR_CATALOG_FILE: "replayed.json",
    VECTOR_MODELS_SHA256: new Bun.CryptoHasher("sha256").update(snapshot).digest("hex"),
  })
  expect(replayed.code, replayed.stderr).toBe(0)
  expect(await Bun.file(path.join(tmp.dir, "replayed.json")).text()).toBe(snapshot)
})

test("a changed or missing pinned snapshot fails before producing a release catalog", async () => {
  await using tmp = await fixture({ anthropic: { api: "https://api.anthropic.com/v1" } })
  await Bun.write(path.join(tmp.dir, "input.json"), JSON.stringify({ changed: {} }))
  const changed = await generate(tmp.dir, { VECTOR_MODELS_SHA256: tmp.sha256 })
  expect(changed.code).not.toBe(0)
  expect(changed.stderr).toContain("digest does not match")
  const missing = await generate(tmp.dir, { VECTOR_MODELS_PATH: "", VECTOR_MODELS_SHA256: tmp.sha256 })
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("requires VECTOR_MODELS_PATH")
  expect(await Bun.file(path.join(tmp.dir, "api.json")).exists()).toBe(false)
})

for (const input of [{}, [], { opencode: {} }]) {
  test(`refuses an empty or wholly retired catalog ${JSON.stringify(input)}`, async () => {
    await using tmp = await fixture(input)
    const result = await generate(tmp.dir, {})
    expect(result.code).not.toBe(0)
    expect(await Bun.file(path.join(tmp.dir, "api.json")).exists()).toBe(false)
  })
}
