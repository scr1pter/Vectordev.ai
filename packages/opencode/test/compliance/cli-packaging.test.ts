import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../../..")
const notices = ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]
const targets = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"]
const version = "1.2.3"

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vector-cli-packaging-"))
  await Bun.write(
    path.join(dir, "packages/opencode/script/publish-vector.ts"),
    Bun.file(path.join(root, "packages/opencode/script/publish-vector.ts")),
  )
  await Bun.write(path.join(dir, "packages/desktop/package.json"), JSON.stringify({ version }))
  await Bun.write(path.join(dir, "user.npmrc"), "")
  await Bun.write(path.join(dir, "global.npmrc"), "")
  for (const notice of notices) await Bun.write(path.join(dir, notice), `Fixture ${notice}\n`)
  for (const target of targets) {
    const folder = path.join(dir, "packages/opencode/dist", `opencode-${target}`)
    const [platform, arch] = target.split("-")
    await Bun.write(
      path.join(folder, "package.json"),
      JSON.stringify({
        name: `opencode-${target}`,
        version,
        os: [platform === "windows" ? "win32" : platform],
        cpu: [arch],
        files: ["bin", ...notices],
      }),
    )
    await Bun.write(
      path.join(folder, "bin", platform === "windows" ? "vector.exe" : "vector"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), vector: process.env.VECTOR_CLI }))\n",
    )
    for (const notice of notices) await Bun.write(path.join(folder, notice), Bun.file(path.join(dir, notice)))
  }
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      HOME: path.join(dir, "home"),
      NPM_CONFIG_USERCONFIG: path.join(dir, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(dir, "global.npmrc"),
      NPM_CONFIG_CACHE: path.join(dir, "npm-cache"),
      NPM_CONFIG_FETCH_RETRIES: "0",
      NPM_CONFIG_FETCH_TIMEOUT: "1000",
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    },
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  }
}

async function run(command: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

test("dry-run packages every target with notices and a working Vector launcher without registry access", async () => {
  await using tmp = await fixture()
  const requests: string[] = []
  const registry = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(request.url)
      return Response.json({ version })
    },
  })
  try {
    const cwd = path.join(tmp.dir, "packages/opencode")
    // Observe the real publisher's build boundary without compiling the application.
    await Bun.write(
      path.join(cwd, "script/build.ts"),
      'await Bun.write("build-env.json", JSON.stringify({ version: process.env.VECTOR_VERSION, targets: process.env.VECTOR_TARGETS, release: process.env.VECTOR_RELEASE, legacyRelease: process.env.OPENCODE_RELEASE }))\n',
    )
    const result = await run([process.execPath, "script/publish-vector.ts", "--dry-run"], cwd, {
      ...tmp.env,
      NPM_CONFIG_REGISTRY: registry.url.toString(),
      VECTOR_VERSION: "stale-inherited-version",
      VECTOR_TARGETS: "stale-inherited-target",
      VECTOR_RELEASE: "true",
      OPENCODE_RELEASE: "true",
      VECTOR_CLI_VERSION: version,
      VECTOR_CLI_TARGETS: targets.join(","),
    })
    expect(result.code, result.stderr).toBe(0)
    expect(requests).toEqual([])
    expect(await Bun.file(path.join(cwd, "build-env.json")).json()).toEqual({
      version,
      targets: targets.join(","),
      release: "",
      legacyRelease: "",
    })

    for (const target of [...targets, "umbrella"]) {
      const folder = path.join(cwd, "dist", target === "umbrella" ? "vectordev-cli" : `opencode-${target}`)
      const manifest = await Bun.file(path.join(folder, "package.json")).json()
      expect(manifest.version).toBe(version)
      expect(manifest.license).toBe("SEE LICENSE IN LICENSE")
      expect(manifest.name).toBe(target === "umbrella" ? "@vectordevai/cli" : `@vectordevai/cli-${target}`)
      const packed = await run(["npm", "pack", "--json", "--offline"], folder, tmp.env)
      expect(packed.code, packed.stderr).toBe(0)
      const info = JSON.parse(packed.stdout)[0]
      const files = info.files.map((file: { path: string }) => file.path)
      for (const notice of notices) expect(files).toContain(notice)
      expect(files.filter((name: string) => name.startsWith("bin/"))).toEqual([
        target === "umbrella" ? "bin/vector.cjs" : target.startsWith("windows") ? "bin/vector.exe" : "bin/vector",
      ])
      if (target === "umbrella") {
        expect(manifest.bin).toEqual({ vector: "./bin/vector.cjs" })
        expect(manifest.optionalDependencies).toEqual(
          Object.fromEntries(targets.map((item) => [`@vectordevai/cli-${item}`, version])),
        )
      }
      const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
      if (target !== "umbrella" && target !== host) continue
      const destination = path.join(tmp.dir, "installed/node_modules", manifest.name)
      await mkdir(destination, { recursive: true })
      const unpacked = await run(
        ["tar", "-xf", path.join(folder, info.filename), "--strip-components", "1", "-C", destination],
        cwd,
        tmp.env,
      )
      expect(unpacked.code, unpacked.stderr).toBe(0)
      for (const notice of notices)
        expect(await Bun.file(path.join(destination, notice)).text()).toBe(`Fixture ${notice}\n`)
    }
    // The fixture is a script; Windows requires a compiled PE executable for this final smoke check.
    if (process.platform === "win32") return
    const launched = await run(
      [
        "node",
        path.join(tmp.dir, "installed/node_modules/@vectordevai/cli/bin/vector.cjs"),
        "argument with spaces",
        "--version",
      ],
      cwd,
      tmp.env,
    )
    expect(launched.code, launched.stderr).toBe(0)
    expect(JSON.parse(launched.stdout)).toEqual({ args: ["argument with spaces", "--version"], vector: "1" })
  } finally {
    registry.stop(true)
  }
}, 30_000)

for (const problem of ["stale version", "missing binary", "missing notice", "excluded notice", "shared credential"]) {
  test(`refuses every package before publishing when the final target has ${problem}`, async () => {
    await using tmp = await fixture()
    const cwd = path.join(tmp.dir, "packages/opencode")
    const folder = path.join(cwd, "dist/opencode-windows-x64")
    if (problem === "stale version" || problem === "excluded notice") {
      const file = Bun.file(path.join(folder, "package.json"))
      const manifest = await file.json()
      if (problem === "stale version") manifest.version = "0.0.1"
      if (problem === "excluded notice") manifest.files = ["bin", "LICENSE"]
      await file.write(JSON.stringify(manifest))
    }
    if (problem === "missing binary") await rm(path.join(folder, "bin/vector.exe"))
    if (problem === "missing notice") await rm(path.join(folder, "THIRD_PARTY_NOTICES.md"))
    if (problem === "shared credential")
      await Bun.write(path.join(folder, "bin/vector.exe"), 'compiled fixture apiKey:"public"')
    const result = await run([process.execPath, "script/publish-vector.ts", "--skip-build", "--dry-run"], cwd, tmp.env)
    expect(result.code).not.toBe(0)
    expect((await Bun.file(path.join(cwd, "dist/opencode-darwin-arm64/package.json")).json()).name).toBe(
      "opencode-darwin-arm64",
    )
    expect(await Bun.file(path.join(cwd, "dist/vectordev-cli/package.json")).exists()).toBe(false)
  })
}
