import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

// Several catalog plugins run through `uvx` or `npx`. Vector resolves an already
// installed runner, but never downloads and executes a mutable installer at runtime.

export type RuntimeName = "uvx" | "npx"

export type RuntimeStatus = {
  name: RuntimeName
  available: boolean
  path?: string
  installed?: boolean
  error?: string
}

// uv installs here by default on macOS and Linux; Windows uses its own path.
const EXTRA_LOOKUP: Record<RuntimeName, string[]> = {
  uvx: [
    join(homedir(), ".local", "bin", platform() === "win32" ? "uvx.exe" : "uvx"),
    join(homedir(), ".cargo", "bin", platform() === "win32" ? "uvx.exe" : "uvx"),
    "/opt/homebrew/bin/uvx",
    "/usr/local/bin/uvx",
  ],
  npx: ["/opt/homebrew/bin/npx", "/usr/local/bin/npx"],
}

function run(command: string, args: string[], timeoutMs = 20_000) {
  return new Promise<{ stdout: string; stderr: string; failed: boolean }>((resolve) => {
    execFile(
      command,
      args,
      { env: untrustedChildEnvironment(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) }),
    )
  })
}

const executable = async (path: string) =>
  access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false)

export async function resolveRuntime(name: RuntimeName): Promise<string | undefined> {
  const which = await run(platform() === "win32" ? "where" : "which", [name], 8_000)
  const found = which.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!which.failed && found) return found
  for (const candidate of EXTRA_LOOKUP[name]) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

export async function ensureRuntime(name: RuntimeName, options?: { install?: boolean }): Promise<RuntimeStatus> {
  const existing = await resolveRuntime(name)
  if (existing) return { name, available: true, path: existing }

  return {
    name,
    available: false,
    error:
      name === "npx"
        ? "npx was not found. It ships with Node.js, so installing Node will provide it."
        : options?.install === false
          ? `${name} is not installed.`
          : "uvx was not found. Install a trusted, pinned uv release before enabling this plugin.",
  }
}

// Rewrites a plugin's command so it runs the resolved absolute path. The engine
// spawns without a login shell, so a bare `uvx` that only exists in ~/.local/bin
// would not be found even once installed.
export async function preparePluginCommand(command: string[]): Promise<{ command: string[]; status?: RuntimeStatus }> {
  const head = command[0]
  if (head !== "uvx" && head !== "npx") return { command }
  const status = await ensureRuntime(head)
  if (!status.available || !status.path) return { command, status }
  return { command: [status.path, ...command.slice(1)], status }
}
