import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compileRuntime, validateCompileRuntime } from "../../../../script/compile-runtime"
import pkg from "../../../../package.json"

const target = { os: process.platform, arch: process.arch }

test("default compilation does not require a custom runtime or change the target matrix", async () => {
  expect(await compileRuntime({ single: false, baseline: false, targets: [] })).toBeUndefined()
})

test("custom runtimes reject matrix, baseline and non-native target requests before executing", async () => {
  for (const options of [
    { single: false, baseline: false, targets: [target] },
    { single: true, baseline: true, targets: [target] },
    { single: true, baseline: false, targets: [target, target] },
    { single: true, baseline: false, targets: [{ ...target, arch: "wrong-architecture" }] },
    { single: true, baseline: false, targets: [{ ...target, abi: "musl" }] },
  ])
    await expect(compileRuntime({ executable: process.execPath, ...options })).rejects.toThrow()
})

test("runtime validation rejects a different version, architecture, operating system or libc", () => {
  const native = { version: pkg.packageManager.replace(/^bun@/, ""), platform: "linux", arch: "x64", libc: "glibc" }
  const linux = { os: "linux", arch: "x64" }
  expect(() => validateCompileRuntime(native, linux)).not.toThrow()
  for (const change of [{ version: "0.0.0" }, { arch: "arm64" }, { platform: "darwin" }, { libc: "musl" }])
    expect(() => validateCompileRuntime({ ...native, ...change }, linux)).toThrow()
})

test("the selected Bun executable can compile and run a replacement-runtime application", async () => {
  const executablePath = await compileRuntime({
    executable: process.execPath,
    single: true,
    baseline: false,
    targets: [target],
  })
  const dir = await mkdtemp(path.join(os.tmpdir(), "vector-compile-runtime-"))
  try {
    const entrypoint = path.join(dir, "entry.ts")
    await Bun.write(entrypoint, 'console.log("replacement runtime fixture")')
    const outfile = path.join(dir, process.platform === "win32" ? "fixture.exe" : "fixture")
    const result = await Bun.build({
      entrypoints: [entrypoint],
      compile: { executablePath, outfile, autoloadBunfig: false, autoloadDotenv: false },
    })
    expect(result.success).toBe(true)
    const child = Bun.spawn([outfile], { stdout: "pipe", stderr: "pipe" })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe("replacement runtime fixture")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
