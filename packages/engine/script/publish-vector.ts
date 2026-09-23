#!/usr/bin/env bun
/**
 * Publishes the Vector CLI to npm as `@vectordevai/cli`.
 *
 *   bun run script/publish-vector.ts            # build + publish
 *   bun run script/publish-vector.ts --dry-run  # build + pack, no publish
 *   bun run script/publish-vector.ts --skip-build
 *
 * Env:
 *   VECTOR_CLI_VERSION   version to publish (default: packages/desktop version)
 *   VECTOR_CLI_TARGETS   comma list, default darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64
 *
 * Layout mirrors how opencode ships: one thin umbrella package whose `vector`
 * bin resolves a platform package (@vectordevai/cli-<os>-<arch>) that carries the
 * compiled binary. npm only installs the optionalDependency matching the host.
 */
import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"
import desktop from "../../desktop/package.json"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const SCOPE = "@vectordevai"
const UMBRELLA = `${SCOPE}/cli`
const version = process.env.VECTOR_CLI_VERSION ?? desktop.version
const targets = (process.env.VECTOR_CLI_TARGETS ?? "darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
const dryRun = process.argv.includes("--dry-run")
const skipBuild = process.argv.includes("--skip-build")

if (!skipBuild) {
  await $`bun run script/build.ts --skip-install`.env({
    ...process.env,
    VECTOR_VERSION: version,
    VECTOR_TARGETS: targets.join(","),
    OPENCODE_VERSION: version,
    OPENCODE_TARGETS: targets.join(","),
    ...(dryRun ? { VECTOR_RELEASE: "", OPENCODE_RELEASE: "" } : {}),
  })
}

// Verify every platform before publishing any package, including when reusing a build.
for (const suffix of targets) {
  const manifest = await Bun.file(path.join("dist", `vector-${suffix}`, "package.json")).json()
  if (manifest.version !== version) {
    throw new Error(`Refusing to relabel ${suffix} build ${manifest.version} as ${version}; rebuild the CLI`)
  }
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
  if (Buffer.from(await Bun.file(binary).arrayBuffer()).includes('apiKey:"public"')) {
    throw new Error(`Refusing to publish ${suffix}: the binary still embeds the retired shared-gateway credential`)
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

// 3. Publish (platform packages first so the umbrella's optionalDependencies resolve)
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
