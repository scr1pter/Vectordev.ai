import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import pkg from "../package.json"

const execFileAsync = promisify(execFile)
const root = path.resolve(import.meta.dirname, "..")
const version = pkg.packageManager.replace(/^bun@/, "")

type Target = { os: string; arch: string; abi?: string; avx2?: false }
type Runtime = { version: string; platform: string; arch: string; libc: string | null }

export function validateCompileRuntime(runtime: Runtime, target: Target) {
  if (runtime.version !== version) throw new Error(`Custom Bun runtime must be version ${version}`)
  if (runtime.platform !== target.os || runtime.arch !== target.arch)
    throw new Error("Custom Bun runtime must match the native target OS and architecture")
  if (target.os === "linux" && runtime.libc !== (target.abi ?? "glibc"))
    throw new Error("Custom Bun runtime must match the target libc ABI")
}

export async function compileRuntime(input: {
  executable?: string
  single: boolean
  baseline: boolean
  targets: readonly Target[]
}) {
  if (input.executable === undefined) return undefined
  if (!input.executable.trim()) throw new Error("VECTOR_BUN_EXECUTABLE_PATH must be a nonempty executable path")
  if (!input.single || input.baseline || input.targets.length !== 1)
    throw new Error("VECTOR_BUN_EXECUTABLE_PATH requires --single without --baseline")
  const target = input.targets[0]
  if (target.os !== process.platform || target.arch !== process.arch || target.abi || target.avx2 === false)
    throw new Error("Custom Bun runtime supports only the native default target")
  if (Bun.version !== version) throw new Error(`Build compiler must be Bun ${version}`)
  const executable = await realpath(input.executable)
  if (!(await stat(executable)).isFile()) throw new Error("Custom Bun runtime must be a regular executable file")
  // Probe the selected executable itself; the compiler's own version/architecture
  // does not establish which runtime will be embedded by compile.executablePath.
  const result = await execFileAsync(
    executable,
    [
      "--no-env-file",
      "--eval",
      'const header = process.report.getReport().header; console.log(JSON.stringify({ version: Bun.version, platform: process.platform, arch: process.arch, libc: process.platform === "linux" ? (header.glibcVersionRuntime ? "glibc" : "musl") : null }))',
    ],
    { cwd: root, timeout: 10_000, maxBuffer: 65_536, env: { ...process.env, BUN_OPTIONS: "", NODE_OPTIONS: "" } },
  )
  validateCompileRuntime(JSON.parse(result.stdout), target)
  return executable
}
