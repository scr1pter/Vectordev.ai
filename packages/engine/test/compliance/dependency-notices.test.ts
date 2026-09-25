import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vector-notices-"))
  await Bun.write(
    path.join(dir, "bun.lock"),
    JSON.stringify({
      packages: {
        unavailable: ["unavailable@1.0.0", "", { os: "win32" }, "sha512-fixture"],
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
        dependencies: name === "direct" ? { transitive: "1.0.0" } : name === "transitive" ? { direct: "1.0.0" } : {},
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
