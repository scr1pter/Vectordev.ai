import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { dependencyNotices } from "../../../../script/dependency-notices"

const integrity = `sha512-${Buffer.alloc(64, 42).toString("base64")}`

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector-bundled-notices-"))
  const record = {
    name: "provider",
    version: "1.0.0",
    integrity,
    source: "https://registry.npmjs.org/provider/-/provider-1.0.0.tgz",
    publisherCommit: "a".repeat(40),
    publisherLock: `https://raw.githubusercontent.com/fixture/provider/${"a".repeat(40)}/package-lock.json`,
    components: [
      {
        name: "embedded",
        version: "2.0.0",
        license: "MIT",
        integrity,
        source: "https://registry.npmjs.org/embedded/-/embedded-2.0.0.tgz",
        publisherPath: "node_modules/embedded",
        texts: ["### LICENSE\n\nEmbedded MIT license", "### NOTICE\n\nUpstream embedded NOTICE"],
        textSha256: "",
      },
    ],
  }
  record.components[0].textSha256 = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(record.components[0].texts))
    .digest("hex")
  await Bun.write(
    path.join(directory, "bun.lock"),
    JSON.stringify({
      workspaces: Object.fromEntries(["engine", "app", "desktop", "tui", "ui"].map((name) => [`packages/${name}`, {}])),
      packages: {
        provider: ["provider@1.0.0", "", {}, integrity],
        embedded: ["embedded@2.0.0", "", {}, integrity],
      },
    }),
  )
  for (const workspace of ["engine", "app", "desktop", "tui", "ui"])
    await Bun.write(
      path.join(directory, "packages", workspace, "package.json"),
      JSON.stringify({
        name: workspace,
        version: "1.0.0",
        dependencies: workspace === "engine" ? { provider: "1.0.0", embedded: "2.0.0" } : {},
      }),
    )
  for (const name of ["provider", "embedded"]) {
    await Bun.write(
      path.join(directory, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: name === "provider" ? "1.0.0" : "2.0.0", license: "MIT" }),
    )
    await Bun.write(
      path.join(directory, "node_modules", name, "LICENSE"),
      name === "embedded" ? "Embedded MIT license" : "Provider MIT license",
    )
  }
  const inventory = path.join(directory, "licenses/dependencies/bundled-provider-notices.json")
  await Bun.write(inventory, JSON.stringify({ "provider@1.0.0": record }))
  return { directory, record, inventory, [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) }
}

test("embedded components join the offline runtime closure and preserve NOTICE across normal deduplication", async () => {
  await using item = await fixture()
  const result = await dependencyNotices(item.directory)
  expect(result.count).toBe(2)
  expect(result.body.split("## embedded@2.0.0")).toHaveLength(2)
  expect(result.body.split("Embedded MIT license")).toHaveLength(2)
  expect(result.body).toContain("Upstream embedded NOTICE")
  await rm(path.join(item.directory, "node_modules/embedded"), { recursive: true })
  await Bun.write(
    path.join(item.directory, "packages/engine/package.json"),
    JSON.stringify({ name: "engine", dependencies: { provider: "1.0.0" } }),
  )
  expect((await dependencyNotices(item.directory)).body).toContain("## embedded@2.0.0")
})

test.each([
  "parent-version",
  "parent-integrity",
  "component-integrity",
  "component-source",
  "component-text",
  "duplicate",
  "empty",
  "publisher",
])("rejects stale or incomplete bundled notice %s", async (mode) => {
  await using item = await fixture()
  if (mode === "parent-version") item.record.version = "1.0.1"
  if (mode === "parent-integrity") item.record.integrity = `sha512-${Buffer.alloc(64, 43).toString("base64")}`
  if (mode === "component-integrity") item.record.components[0].integrity = "not-verified"
  if (mode === "component-source") item.record.components[0].source = "https://attacker.invalid/package.tgz"
  if (mode === "component-text") item.record.components[0].texts[0] = "Changed licensed text"
  if (mode === "duplicate") item.record.components.push(item.record.components[0])
  if (mode === "empty") item.record.components.length = 0
  if (mode === "publisher") item.record.publisherCommit = "b".repeat(40)
  await Bun.write(item.inventory, JSON.stringify({ "provider@1.0.0": item.record }))
  await expect(dependencyNotices(item.directory)).rejects.toThrow(/bundled/i)
})

test("removed or updated provider cannot silently leave an unused inventory", async () => {
  await using item = await fixture()
  await Bun.write(
    path.join(item.directory, "packages/engine/package.json"),
    JSON.stringify({ name: "engine", dependencies: {} }),
  )
  await expect(dependencyNotices(item.directory)).rejects.toThrow("Unused bundled provider notice records")
})

test("conflicting installed and embedded license declarations fail instead of replacing a notice", async () => {
  await using item = await fixture()
  item.record.components[0].license = "Apache-2.0"
  await Bun.write(item.inventory, JSON.stringify({ "provider@1.0.0": item.record }))
  await expect(dependencyNotices(item.directory)).rejects.toThrow("Conflicting license declarations")
})

test.each(["[]", "null", '"not-an-inventory"', "{"])(
  "malformed inventory %s fails rather than dropping embedded notices",
  async (data) => {
    await using item = await fixture()
    await Bun.write(item.inventory, data)
    await expect(dependencyNotices(item.directory)).rejects.toThrow()
  },
)

test("known embedded providers require an inventory even if its file or entry was removed", async () => {
  await using item = await fixture()
  const name = "merge-gateway-ai-sdk-provider"
  await Bun.write(
    path.join(item.directory, "packages/engine/package.json"),
    JSON.stringify({ name: "engine", dependencies: { [name]: "0.3.0" } }),
  )
  await Bun.write(
    path.join(item.directory, "node_modules", name, "package.json"),
    JSON.stringify({ name, version: "0.3.0", license: "MIT" }),
  )
  await Bun.write(path.join(item.directory, "node_modules", name, "LICENSE"), "Provider MIT license")
  const lock = await Bun.file(path.join(item.directory, "bun.lock")).json()
  await Bun.write(
    path.join(item.directory, "bun.lock"),
    JSON.stringify({ ...lock, packages: { ...lock.packages, [name]: [`${name}@0.3.0`, "", {}, integrity] } }),
  )
  await Bun.write(item.inventory, "{}")
  await expect(dependencyNotices(item.directory)).rejects.toThrow("Missing bundled provider notices")
  await rm(item.inventory)
  await expect(dependencyNotices(item.directory)).rejects.toThrow("Missing bundled provider notices")
})

test("rendering normalizes line endings while validating the unchanged source notice hash", async () => {
  await using item = await fixture()
  item.record.components[0].texts[1] = "### NOTICE\r\n\r\nCopyright upstream  \r\nExact permission terms\t\r\n"
  item.record.components[0].textSha256 = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(item.record.components[0].texts))
    .digest("hex")
  await Bun.write(item.inventory, JSON.stringify({ "provider@1.0.0": item.record }))
  const result = await dependencyNotices(item.directory)
  expect(result.body).toContain("### NOTICE\n\nCopyright upstream\nExact permission terms\n")
  expect(result.body).not.toContain("\r")
  expect((await Bun.file(item.inventory).json())["provider@1.0.0"].components[0].texts[1]).toContain("\r\n")
})
