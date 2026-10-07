#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import { rm } from "fs/promises"
import path from "path"
import { Script } from "@vectordevai/script"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import pkg from "../package.json"
import { modelsData } from "./generate"
import { compileRuntime } from "../../../script/compile-runtime"

const dir = path.resolve(import.meta.dirname, "..")
const binary = "lildax"
process.chdir(dir)

const singleFlag = process.argv.includes("--single")
const baselineFlag = process.argv.includes("--baseline")
const skipInstall = process.argv.includes("--skip-install")
const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()

const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
]

const targets = singleFlag
  ? allTargets.filter((item) => {
      if (item.os !== process.platform || item.arch !== process.arch) return false
      if (item.avx2 === false) return baselineFlag
      return item.abi === undefined
    })
  : allTargets

const executablePath = await compileRuntime({
  executable: process.env.VECTOR_BUN_EXECUTABLE_PATH,
  single: singleFlag,
  baseline: baselineFlag,
  targets,
})

await rm("dist", { recursive: true, force: true })

if (!skipInstall) await $`bun install --os="*" --cpu="*" @opentui/core@${pkg.dependencies["@opentui/core"]}`

const { dependencyNotices } = await import("../../../script/dependency-notices.ts")
const notices = await dependencyNotices(path.resolve(dir, "../.."))
await Bun.write(path.resolve(dir, "../../DEPENDENCY_NOTICES.md"), notices.body)

const localParserWorker = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootParserWorker = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localParserWorker) ? localParserWorker : rootParserWorker)

for (const item of targets) {
  const target = [
    binary,
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.avx2 === false ? "baseline" : undefined,
    item.abi,
  ]
    .filter(Boolean)
    .join("-")
  const name = target.replace(binary, "cli-dev")
  console.log(`building ${name}`)
  const result = await Bun.build({
    entrypoints: ["./src/index.ts", parserWorker],
    tsconfig: "./tsconfig.json",
    plugins: [plugin],
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: sourcemapsFlag ? "linked" : "none",
    splitting: true,
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: target.replace(binary, "bun") as Bun.Build.CompileTarget,
      ...(executablePath ? { executablePath } : {}),
      outfile: `./dist/${name}/bin/${binary}`,
      execArgv: [`--user-agent=${binary}/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    define: {
      VECTOR_VERSION: `'${Script.version}'`,
      VECTOR_CLI_NAME: `'${binary}'`,
      VECTOR_MODEL_CATALOG: modelsData,
      VECTOR_CHANNEL: `'${Script.channel}'`,
      VECTOR_LIBC: item.os === "linux" ? `'${item.abi ?? "glibc"}'` : "undefined",
      // FFF_LIBC selects the fff native lib variant: "musl" or "gnu".
      FFF_LIBC: item.os === "linux" ? `'${item.abi ?? "gnu"}'` : "undefined",
      OTUI_TREE_SITTER_WORKER_PATH:
        (item.os === "win32" ? '"B:/~BUN/root/' : '"/$bunfs/root/') +
        path.relative(dir, parserWorker).replaceAll("\\", "/") +
        '"',
      ...(item.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(item.abi ?? "glibc") } : {}),
    },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }

  await Bun.write(
    `./dist/${name}/package.json`,
    JSON.stringify(
      {
        name: `@vectordevai/${name}`,
        version: Script.version,
        private: true,
        license: "SEE LICENSE IN LICENSE",
        files: ["bin", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"],
        repository: { type: "git", url: "git+https://github.com/scr1pter/Vectordev.ai.git" },
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]) {
    await Bun.write(`dist/${name}/${notice}`, Bun.file(path.join(dir, "../..", notice)))
  }
}
