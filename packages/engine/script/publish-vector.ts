#!/usr/bin/env bun
/**
 * Publishes the Vector CLI to npm as `@vectordevai/cli`.
 *
 *   bun run script/publish-vector.ts            # build + pack, no publish
 *   bun run script/publish-vector.ts --dry-run  # build + pack, no publish
 *   bun run script/publish-vector.ts --publish  # explicitly publish plugin, then CLI
 *   bun run script/publish-vector.ts --skip-build
 *   bun run script/publish-vector.ts --fresh-catalog # explicit first-release preparation
 *
 * Env:
 *   VECTOR_RELEASE_CATALOG_PATH / VECTOR_RELEASE_CATALOG_SHA256  reviewed workflow artifact
 *   VECTOR_CLI_VERSION   version to publish (default: packages/desktop version)
 *   VECTOR_CLI_TARGETS   comma list, default darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64
 *                        (the desktop release refuses to start unless every one of these is on npm)
 *
 * One thin umbrella package exposes the `vector` command and
 * bin resolves a platform package (@vectordevai/cli-<os>-<arch>) that carries the
 * compiled binary. npm only installs the optionalDependency matching the host.
 */
import { $ } from "bun"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { catalogDigest, ensurePublishedCatalog, prepareReleaseCatalog } from "./release-catalog"
import { fileURLToPath } from "url"
import desktop from "../../desktop/package.json"
import plugin from "../../plugin/package.json"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const SCOPE = "@vectordevai"
const UMBRELLA = `${SCOPE}/cli`
const version = process.env.VECTOR_CLI_VERSION ?? desktop.version
const targets = (
  process.env.VECTOR_CLI_TARGETS ?? "darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64"
)
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
const dryRun = !process.argv.includes("--publish")
if (!dryRun && process.argv.includes("--dry-run")) throw new Error("Choose --publish or --dry-run, not both")
const skipBuild = process.argv.includes("--skip-build")
const catalogDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vector-release-catalog-"))
await using catalogCleanup = { [Symbol.asyncDispose]: () => fs.rm(catalogDirectory, { recursive: true, force: true }) }
const catalog = await prepareReleaseCatalog({
  version,
  directory: catalogDirectory,
  fresh: process.argv.includes("--fresh-catalog"),
  file: process.env.VECTOR_RELEASE_CATALOG_PATH,
  sha256: process.env.VECTOR_RELEASE_CATALOG_SHA256,
})

if (!skipBuild) {
  await $`bun run script/build.ts --skip-install`.env({
    ...process.env,
    VECTOR_VERSION: version,
    VECTOR_PLUGIN_VERSION: version,
    VECTOR_TARGETS: targets.join(","),
    VECTOR_RELEASE_CATALOG_PATH: catalog.file,
    VECTOR_RELEASE_CATALOG_SHA256: catalog.sha256,
    ...(dryRun ? { VECTOR_RELEASE: "" } : {}),
  })
}

// dist/api.json records what the compiler embedded and verifies reused builds too.
if (catalogDigest(await Bun.file("dist/api.json").text()) !== catalog.sha256)
  throw new Error("CLI build catalog differs from the immutable release catalog; rebuild the CLI")

// Verify every platform before publishing any package, including when reusing a build.
for (const suffix of targets) {
  const manifest = await Bun.file(path.join("dist", `vector-${suffix}`, "package.json")).json()
  if (manifest.version !== version) {
    throw new Error(`Refusing to relabel ${suffix} build ${manifest.version} as ${version}; rebuild the CLI`)
  }
  if (manifest.vectorCatalogSha256 !== catalog.sha256)
    throw new Error(`Catalog provenance for ${suffix} does not match this release; rebuild the CLI`)
  const [os, cpu] = suffix.split("-")
  if (!manifest.os?.includes(os === "windows" ? "win32" : os) || !manifest.cpu?.includes(cpu)) {
    throw new Error(`Platform manifest does not match ${suffix}`)
  }
  for (const file of ["bin", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    if (!manifest.files?.includes(file)) throw new Error(`Missing ${file} from ${suffix} package file list`)
  }
  const binary = path.join("dist", `vector-${suffix}`, "bin", suffix.startsWith("windows") ? "vector.exe" : "vector")
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    if (!(await Bun.file(path.join("dist", `vector-${suffix}`, notice)).exists())) {
      throw new Error(`Missing ${notice} in ${suffix}`)
    }
  }
  const bytes = Buffer.from(await Bun.file(binary).arrayBuffer())
  // The Codex CLI client is allowed again: the owner restored ChatGPT sign-in
  // on 26 September 2026.
  for (const credential of [
    'apiKey:"public"',
    "1d89f9fdb23ee96d4e603201f6861dab6e143c5c3c00469a018a2d94bdc03d4e",
    "Ov23li8tweQw6odWQebz",
  ]) {
    if (bytes.includes(credential))
      throw new Error(
        `Refusing to publish ${suffix}: the binary embeds a retired credential or borrowed OAuth registration`,
      )
  }
}

// 1. Rename platform packages: vector-<suffix> -> @vectordevai/cli-<suffix>
const platformPackages: Record<string, string> = {}
for (const suffix of targets) {
  const src = `dist/vector-${suffix}`
  const name = `${SCOPE}/cli-${suffix}`
  const manifest = await Bun.file(`${src}/package.json`).json()
  await Bun.file(`${src}/package.json`).write(
    JSON.stringify(
      { ...manifest, name, version, license: "SEE LICENSE IN LICENSE", description: `Vector CLI binary for ${suffix}` },
      null,
      2,
    ),
  )
  platformPackages[name] = version
}

// 2. Umbrella package with the `vector` bin
const out = "dist/vectordev-cli"
await $`rm -rf ${out}`
await $`mkdir -p ${out}/bin`
for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
  await Bun.write(`${out}/${notice}`, Bun.file(`../../${notice}`))
}
await Bun.file(`${out}/README.md`).write(
  [
    "# Vector CLI",
    "",
    "The Vector agent in your terminal. Free with a Vector account.",
    "",
    "```sh",
    "npm install -g @vectordevai/cli",
    "vector login        # opens vectordev.ai/auth/cli",
    "vector              # start the agent in the current repository",
    "vector auth login   # connect your model provider",
    "```",
    "",
    "Connect a supported provider with your own credentials, then choose a model with vector models.",
    "For GitHub reviews, set the MODEL workflow input and its provider secret.",
    "",
  ].join("\n"),
)
await Bun.file(`${out}/bin/vector.cjs`).write(`#!/usr/bin/env node
// Vector CLI launcher: resolves the platform binary package and runs it with
// Vector branding + the free-account gate enabled.
const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")

const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]
const arch = { arm64: "arm64", x64: "x64" }[process.arch]
const pkg = "${SCOPE}/cli-" + platform + "-" + arch

let binary
try {
  const root = path.dirname(require.resolve(pkg + "/package.json"))
  binary = [path.join(root, "bin", "vector.exe"), path.join(root, "bin", "vector")].find((p) => fs.existsSync(p))
} catch {}
if (!binary) {
  console.error("Vector CLI: no prebuilt binary for " + process.platform + "/" + process.arch + " (expected " + pkg + ").")
  console.error("Reinstall without --ignore-scripts / --no-optional, or file an issue at https://github.com/scr1pter/Vectordev.ai")
  process.exit(1)
}

const child = childProcess.spawn(binary, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, VECTOR_CLI: "1" },
})
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { try { child.kill(signal) } catch {} })
}
child.on("error", (error) => { console.error(error.message); process.exit(1) })
child.on("exit", (code, signal) => {
  if (signal) { process.kill(process.pid, signal); return }
  process.exit(typeof code === "number" ? code : 0)
})
`)
await Bun.file(`${out}/package.json`).write(
  JSON.stringify(
    {
      name: UMBRELLA,
      version,
      description: "Vector CLI — the Vector agent in your terminal. Free with a Vector account.",
      license: "SEE LICENSE IN LICENSE",
      homepage: "https://vectordev.ai",
      repository: { type: "git", url: "https://github.com/scr1pter/Vectordev.ai.git" },
      keywords: ["vector", "ai", "agent", "cli", "coding-agent", "terminal"],
      bin: { vector: "./bin/vector.cjs" },
      files: ["bin", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"],
      optionalDependencies: platformPackages,
      engines: { node: ">=18" },
    },
    null,
    2,
  ),
)

// The runtime uses this public plugin SDK. It must exist before any CLI publication.
if (plugin.name !== "@vectordevai/plugin") throw new Error("Unexpected plugin package name")
const pluginPublish = Bun.spawn(
  [process.execPath, "script/publish.ts", dryRun ? "--dry-run" : "--publish", ...(skipBuild ? ["--skip-build"] : [])],
  {
    cwd: path.resolve(dir, "../plugin"),
    env: { ...process.env, VECTOR_PLUGIN_VERSION: version },
    stdio: ["inherit", "inherit", "inherit"],
  },
)
const pluginExit = await pluginPublish.exited
if (pluginExit !== 0) process.exit(pluginExit)
if (!dryRun) {
  const available = await $`npm view ${`${plugin.name}@${version}`} version`.quiet().nothrow()
  if (available.exitCode !== 0)
    throw new Error(`Plugin ${plugin.name}@${version} is not available; CLI publication stopped`)
  // The desktop's first release must reuse these exact bytes, too.
  await ensurePublishedCatalog({
    version,
    file: catalog.file,
    upload: async () => {
      const uploader = Bun.spawn([process.execPath, "../cloud/src/upload-model-catalog.ts"], {
        cwd: dir,
        env: { ...process.env, VECTOR_RELEASE_VERSION: version, VECTOR_CATALOG_FILE: catalog.file },
        stdio: ["inherit", "inherit", "inherit"],
      })
      if ((await uploader.exited) !== 0) throw new Error("Catalog publication failed; CLI publication stopped")
    },
  })
}

// Publish platform packages before the umbrella so its optionalDependencies resolve.
async function published(name: string) {
  return (await $`npm view ${name}@${version} version`.quiet().nothrow()).exitCode === 0
}
async function publish(pkgDir: string, name: string) {
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(pkgDir)
  if (dryRun) {
    await $`npm pack --dry-run --offline`.cwd(pkgDir)
    return
  }
  if (await published(name)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  // Inherit the terminal so npm can prompt for 2FA (OTP or browser confirmation).
  const proc = Bun.spawn(["npm", "publish", "--access", "public"], {
    cwd: pkgDir,
    stdio: ["inherit", "inherit", "inherit"],
  })
  if ((await proc.exited) !== 0) throw new Error(`npm publish failed for ${name}`)
  console.log(`published ${name}@${version}`)
}

for (const suffix of targets) await publish(`dist/vector-${suffix}`, `${SCOPE}/cli-${suffix}`)
await publish(out, UMBRELLA)
console.log(dryRun ? "dry run complete" : `\nInstall with: npm install -g ${UMBRELLA}@${version}`)
