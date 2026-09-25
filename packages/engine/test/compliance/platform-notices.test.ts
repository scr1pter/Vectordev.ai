import { expect, test } from "bun:test"
import path from "node:path"
import { readdir, rm } from "node:fs/promises"
import { dependencyNotices } from "../../../../script/dependency-notices"
import { tmpdir } from "../fixture/fixture"

async function fixture() {
  const tmp = await tmpdir()
  const platform = {
    name: "fixture-native",
    version: "1.2.3",
    license: "MIT",
    texts: ["### LICENSE\n\nExact platform license text"],
    integrity: "sha512-fixture",
    source: "https://registry.npmjs.org/fixture-native/-/fixture-native-1.2.3.tgz",
  }
  for (const name of ["engine", "app", "desktop", "tui", "ui"])
    await Bun.write(
      path.join(tmp.path, "packages", name, "package.json"),
      JSON.stringify({
        name: `fixture-${name}`,
        version: "1.0.0",
        dependencies: name === "engine" ? { wrapper: "1.0.0" } : {},
      }),
    )
  await Bun.write(
    path.join(tmp.path, "node_modules/wrapper/package.json"),
    JSON.stringify({
      name: "wrapper",
      version: "1.0.0",
      license: "MIT",
      optionalDependencies: { "fixture-native": "~1.2.0" },
    }),
  )
  await Bun.write(path.join(tmp.path, "node_modules/wrapper/LICENSE"), "Exact wrapper license text")
  await Bun.write(
    path.join(tmp.path, "bun.lock"),
    JSON.stringify({
      packages: {
        wrapper: ["wrapper@1.0.0", "", { optionalDependencies: { "fixture-native": "~1.2.0" } }, "sha512-wrapper"],
        "fixture-native": ["fixture-native@1.2.3", "", { os: "linux", cpu: "x64" }, platform.integrity],
      },
    }),
  )
  const inventory = path.join(tmp.path, "licenses/dependencies/platform-notices.json")
  await Bun.write(inventory, JSON.stringify({ "fixture-native@1.2.3": platform }))
  return { ...tmp, inventory, platform }
}

test("locked native license inventory produces identical notices with or without host platform packages", async () => {
  await using tmp = await fixture()
  const absent = await dependencyNotices(tmp.path)
  await Bun.write(path.join(tmp.path, "node_modules/fixture-native/package.json"), JSON.stringify(tmp.platform))
  await Bun.write(path.join(tmp.path, "node_modules/fixture-native/LICENSE"), "Exact platform license text")
  const present = await dependencyNotices(tmp.path)
  expect(absent).toEqual(present)
  expect(absent.count).toBe(2)
  expect(absent.body).toContain("Exact platform license text")
  const refresh = await dependencyNotices(tmp.path, true)
  expect(refresh).toEqual(absent)
  expect(await dependencyNotices(tmp.path)).toEqual(refresh)
})

test("missing, stale, empty, and unrelated platform records fail regeneration", async () => {
  await using tmp = await fixture()
  for (const inventory of [
    {},
    { "fixture-native@1.2.3": { ...tmp.platform, integrity: "sha512-stale" } },
    { "fixture-native@1.2.3": { ...tmp.platform, source: "https://example.test/license.tgz" } },
    { "fixture-native@1.2.3": { ...tmp.platform, texts: [] } },
    { "fixture-native@1.2.3": { ...tmp.platform, texts: [""] } },
  ]) {
    await Bun.write(tmp.inventory, JSON.stringify(inventory))
    await expect(dependencyNotices(tmp.path)).rejects.toThrow("Missing or stale platform notices")
  }
  await Bun.write(tmp.inventory, JSON.stringify({ "fixture-native@1.2.3": tmp.platform, unrelated: tmp.platform }))
  await expect(dependencyNotices(tmp.path)).rejects.toThrow("Unused platform notice records")
})

test("ordinary runtime packages and their license sources cannot silently disappear", async () => {
  await using tmp = await fixture()
  await rm(path.join(tmp.path, "node_modules/wrapper/LICENSE"))
  await expect(dependencyNotices(tmp.path)).rejects.toThrow("Missing license texts")
  await rm(path.join(tmp.path, "node_modules/wrapper"), { recursive: true })
  await expect(dependencyNotices(tmp.path)).rejects.toThrow("Missing installed runtime dependency wrapper")
})

test("unused overrides and changed platform override text require review", async () => {
  await using tmp = await fixture()
  const override = "fixture-native@1.2.3.txt"
  await Bun.write(path.join(tmp.path, "licenses/dependencies", override), "Changed exact license text")
  await expect(dependencyNotices(tmp.path)).rejects.toThrow("Unused dependency notice overrides")
  await Bun.write(tmp.inventory, JSON.stringify({ "fixture-native@1.2.3": { ...tmp.platform, override } }))
  await expect(dependencyNotices(tmp.path)).rejects.toThrow("Stale platform notice override")
})

test("native dependency ranges resolve through the locked parent instead of an unrelated installed version", async () => {
  await using tmp = await fixture()
  const lock = await Bun.file(path.join(tmp.path, "bun.lock")).json()
  lock.packages["wrapper/fixture-native"] = ["fixture-native@1.2.4", "", { os: "linux" }, "sha512-nested"]
  await Bun.write(path.join(tmp.path, "bun.lock"), JSON.stringify(lock))
  await Bun.write(
    tmp.inventory,
    JSON.stringify({
      "fixture-native@1.2.4": {
        ...tmp.platform,
        version: "1.2.4",
        integrity: "sha512-nested",
        source: "https://registry.npmjs.org/fixture-native/-/fixture-native-1.2.4.tgz",
      },
    }),
  )
  expect((await dependencyNotices(tmp.path)).body).toContain("fixture-native@1.2.4")
})

test("native-only transitive dependencies are covered even when the host does not install them", async () => {
  await using tmp = await fixture()
  const lock = await Bun.file(path.join(tmp.path, "bun.lock")).json()
  lock.packages["fixture-native"][2].dependencies = { "native-support": "1.0.0" }
  lock.packages["native-support"] = ["native-support@1.0.0", "", {}, "sha512-support"]
  await Bun.write(path.join(tmp.path, "bun.lock"), JSON.stringify(lock))
  await Bun.write(
    tmp.inventory,
    JSON.stringify({
      "fixture-native@1.2.3": tmp.platform,
      "native-support@1.0.0": {
        ...tmp.platform,
        name: "native-support",
        version: "1.0.0",
        integrity: "sha512-support",
        source: "https://registry.npmjs.org/native-support/-/native-support-1.0.0.tgz",
      },
    }),
  )
  expect((await dependencyNotices(tmp.path)).body).toContain("native-support@1.0.0")
})

test("importing the notice generator from a build never interprets the caller's CLI flags", async () => {
  await using tmp = await tmpdir()
  const script = path.resolve(import.meta.dirname, "../../../../script/dependency-notices.ts")
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `await import(${JSON.stringify(script)})`,
      "--",
      "--single",
      "--skip-install",
      "--update-platform-notices",
    ],
    {
      cwd: tmp.path,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(stdout).toBe("")
  expect(await readdir(tmp.path)).toEqual([])
})
