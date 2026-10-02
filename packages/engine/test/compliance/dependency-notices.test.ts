import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")

async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "vector-notices-")))
  await Bun.write(
    path.join(dir, "bun.lock"),
    JSON.stringify({
      workspaces: Object.fromEntries(["engine", "app", "desktop", "tui", "ui"].map((name) => [`packages/${name}`, {}])),
      overrides: { transitive: "1.0.0" },
      packages: {
        unavailable: ["unavailable@1.0.0", "", { os: "win32" }, "sha512-fixture"],
        ...Object.fromEntries(
          ["direct", "transitive", "installed", "renderer", "buildtool", "electron"].map((name) => [
            name,
            [`${name}@1.0.0`, "", {}, "sha512-fixture"],
          ]),
        ),
      },
    }),
  )
  await Bun.write(
    path.join(dir, "licenses/dependencies/platform-notices.json"),
    JSON.stringify({
      "unavailable@1.0.0": {
        name: "unavailable",
        version: "1.0.0",
        license: "MIT",
        integrity: "sha512-fixture",
        source: "https://registry.npmjs.org/unavailable/-/unavailable-1.0.0.tgz",
        texts: ["Copyright (c) fixture unavailable\nPermission fixture for unavailable"],
      },
    }),
  )
  for (const name of ["engine", "app", "desktop", "tui", "ui"]) {
    await Bun.write(
      path.join(dir, "packages", name, "package.json"),
      JSON.stringify({
        name: name === "desktop" ? "vector-desktop" : name,
        version: "1.0.0",
        dependencies: name === "engine" ? { direct: "1.0.0" } : {},
        optionalDependencies: name === "engine" ? { installed: "1.0.0", unavailable: "1.0.0" } : {},
        devDependencies: name === "app" ? { renderer: "1.0.0", buildtool: "1.0.0" } : {},
      }),
    )
  }
  await Bun.write(path.join(dir, "packages/app/src/main.ts"), 'import "renderer/subpath"\n')
  for (const name of ["direct", "transitive", "installed", "renderer", "buildtool", "electron"]) {
    await Bun.write(
      path.join(dir, "node_modules", name, "package.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        license: "MIT",
        dependencies: name === "direct" ? { transitive: "0.9.0" } : name === "transitive" ? { direct: "1.0.0" } : {},
      }),
    )
    await Bun.write(
      path.join(dir, "node_modules", name, "LICENSE.md"),
      `Copyright (c) fixture ${name}\nPermission fixture for ${name}\n`,
    )
  }
  return { dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) }
}

async function generate(dir: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import { dependencyNotices } from ${JSON.stringify(path.join(root, "script/dependency-notices.ts"))}; const result = await dependencyNotices(${JSON.stringify(dir)}); await Bun.write(${JSON.stringify(path.join(dir, "DEPENDENCY_NOTICES.md"))}, result.body);`,
    ],
    {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: path.join(dir, "home") },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("notices traverse cycles and native optional dependencies, include renderer imports, and preserve upstream text", async () => {
  await using tmp = await fixture()
  const result = await generate(tmp.dir)
  expect(result.code, result.stderr).toBe(0)
  const output = await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).text()
  for (const name of ["direct", "transitive", "installed", "unavailable", "renderer", "electron"]) {
    expect(output).toContain(`## ${name}@1.0.0\n\nLicense: MIT`)
    expect(output).toContain(`Copyright (c) fixture ${name}\nPermission fixture for ${name}`)
    expect(output.split(`## ${name}@1.0.0`).length).toBe(2)
  }
  expect(output).not.toContain("## buildtool@")
})

test("missing notice text fails closed and an explicit provenance file is copied without inventing attribution", async () => {
  await using tmp = await fixture()
  await rm(path.join(tmp.dir, "node_modules/transitive/LICENSE.md"))
  const missing = await generate(tmp.dir)
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("transitive@1.0.0")
  expect(await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).exists()).toBe(false)
  const notice =
    "Declared license: MIT\nDeclared author: fixture maintainer\nNo copyright notice was supplied upstream.\n"
  await Bun.write(path.join(tmp.dir, "licenses/dependencies/transitive@1.0.0.txt"), notice)
  const restored = await generate(tmp.dir)
  expect(restored.code, restored.stderr).toBe(0)
  expect(await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).text()).toContain(notice)
})

test("an unresolved required runtime dependency fails instead of silently omitting its notice", async () => {
  await using tmp = await fixture()
  await rm(path.join(tmp.dir, "node_modules/transitive"), { recursive: true })
  const result = await generate(tmp.dir)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Missing installed runtime dependency transitive of direct")
})

async function versionedFixture() {
  const tmp = await fixture()
  const lock = await Bun.file(path.join(tmp.dir, "bun.lock")).json()
  await Bun.write(
    path.join(tmp.dir, "bun.lock"),
    JSON.stringify({
      ...lock,
      packages: {
        ...lock.packages,
        dual: ["dual@1.0.0", "", {}, "sha512-fixture"],
        "engine/dual": ["dual@2.0.0", "", {}, "sha512-fixture"],
        "engine/dual/old-dual": ["dual@1.0.0", "", {}, "sha512-fixture"],
        renamed: ["original@1.0.0", "", {}, "sha512-fixture"],
      },
    }),
  )
  for (const name of ["engine", "app"]) {
    const file = Bun.file(path.join(tmp.dir, "packages", name, "package.json"))
    const pkg = await file.json()
    await Bun.write(
      file,
      JSON.stringify({
        ...pkg,
        dependencies: {
          ...pkg.dependencies,
          dual: name === "engine" ? "2.0.0" : "1.0.0",
          renamed: "npm:original@^1.0.0",
        },
      }),
    )
  }
  for (const [folder, name, version] of [
    ["node_modules/dual", "dual", "1.0.0"],
    ["packages/engine/node_modules/dual", "dual", "2.0.0"],
    ["packages/engine/node_modules/dual/node_modules/old-dual", "dual", "1.0.0"],
    ["node_modules/renamed", "original", "1.0.0"],
  ]) {
    await Bun.write(
      path.join(tmp.dir, folder, "package.json"),
      JSON.stringify({
        name,
        version,
        license: "MIT",
        exports: "./dist/entry.js",
        dependencies: version === "2.0.0" ? { "old-dual": "npm:dual@1.0.0" } : {},
      }),
    )
    await Bun.write(path.join(tmp.dir, folder, "dist/entry.js"), `export default ${JSON.stringify(version)}\n`)
    await Bun.write(path.join(tmp.dir, folder, "dist/package.json"), JSON.stringify({ name, version, type: "module" }))
    await Bun.write(path.join(tmp.dir, folder, "LICENSE"), `Exact fixture notice for ${name}@${version}\n`)
  }
  return tmp
}

test("notices preserve both installed versions across hoisted and package-local dependencies, including npm aliases", async () => {
  await using tmp = await versionedFixture()
  const result = await generate(tmp.dir)
  expect(result.code, result.stderr).toBe(0)
  const output = await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).text()
  for (const identity of ["dual@1.0.0", "dual@2.0.0", "original@1.0.0"]) {
    expect(output).toContain(`## ${identity}\n\nLicense: MIT`)
    expect(output).toContain(`Exact fixture notice for ${identity}`)
    expect(output.split(`## ${identity}`).length).toBe(2)
  }
  expect(output).not.toContain("## renamed@")
})

test("a missing locked version fails instead of substituting a different hoisted version", async () => {
  await using tmp = await versionedFixture()
  await rm(path.join(tmp.dir, "packages/engine/node_modules/dual"), { recursive: true })
  const result = await generate(tmp.dir)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Installed runtime dependency dual@2.0.0 of engine")
  expect(result.stderr).toContain("found dual@1.0.0")
  expect(await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).exists()).toBe(false)
})

test("a range-compatible installed version must still be present in the lock", async () => {
  await using tmp = await versionedFixture()
  const app = Bun.file(path.join(tmp.dir, "packages/app/package.json"))
  const pkg = await app.json()
  await Bun.write(app, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, dual: "^1.0.0" } }))
  for (const file of ["package.json", "dist/package.json"]) {
    const manifest = Bun.file(path.join(tmp.dir, "node_modules/dual", file))
    await Bun.write(manifest, JSON.stringify({ ...(await manifest.json()), version: "1.1.0" }))
  }
  const result = await generate(tmp.dir)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("Installed runtime dependency dual@^1.0.0 of app")
  expect(result.stderr).toContain("found dual@1.1.0")
  expect(await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).exists()).toBe(false)
})

test("pinned Git dependencies retain their package notices with Bun's abbreviated lock commit", async () => {
  await using tmp = await fixture()
  const spec = `github:fixture/installed#${"a".repeat(40)}`
  const engine = Bun.file(path.join(tmp.dir, "packages/engine/package.json"))
  const pkg = await engine.json()
  await Bun.write(
    engine,
    JSON.stringify({ ...pkg, optionalDependencies: { ...pkg.optionalDependencies, installed: spec } }),
  )
  const file = Bun.file(path.join(tmp.dir, "bun.lock"))
  const lock = await file.json()
  await Bun.write(
    file,
    JSON.stringify({
      ...lock,
      packages: {
        ...lock.packages,
        installed: ["installed@github:fixture/installed#aaaaaaa", {}, "fixture-installed-aaaaaaa"],
      },
    }),
  )
  const result = await generate(tmp.dir)
  expect(result.code, result.stderr).toBe(0)
  expect(await Bun.file(path.join(tmp.dir, "DEPENDENCY_NOTICES.md")).text()).toContain("## installed@1.0.0")
  await Bun.write(
    engine,
    JSON.stringify({
      ...pkg,
      optionalDependencies: { ...pkg.optionalDependencies, installed: spec.replace(/a+$/, "b".repeat(40)) },
    }),
  )
  const mismatch = await generate(tmp.dir)
  expect(mismatch.code).not.toBe(0)
  expect(mismatch.stderr).toContain("does not match its locked identity/version")
})
