import { execFile } from "node:child_process"
import { access, constants } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { join } from "node:path"

// Several catalog plugins are published to PyPI and run through `uvx`, which is
// not installed on most machines. Without this the plugin installs fine and then
// fails to spawn, which reads as "the plugin is broken" rather than "a runner is
// missing". Vector resolves the runner itself, installing it when absent, so
// connecting a plugin does not turn into a shell errand for the user.

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
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) }),
    )
  })
}

const executable = async (path: string) => access(path, constants.X_OK).then(() => true).catch(() => false)

export async function resolveRuntime(name: RuntimeName): Promise<string | undefined> {
  const which = await run(platform() === "win32" ? "where" : "which", [name], 8_000)
  const found = which.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  if (!which.failed && found) return found
  for (const candidate of EXTRA_LOOKUP[name]) {
    if (await executable(candidate)) return candidate
  }
  return undefined
}

// Installs uv through Astral's published installer. Deliberately not silent
// about what it does: the caller surfaces this to the user, because installing
// software on someone's machine should be visible even when they asked for it.
async function installUv(): Promise<{ ok: boolean; error?: string }> {
  if (platform() === "win32") {
    const result = await run(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
      180_000,
    )
    return result.failed ? { ok: false, error: result.stderr.trim() || "The uv installer failed." } : { ok: true }
  }
  // sh -c rather than shell:true so the command string is fixed here and cannot
  // be influenced by anything the renderer passes in.
  const result = await run("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], 180_000)
  return result.failed ? { ok: false, error: result.stderr.trim() || "The uv installer failed." } : { ok: true }
}

export async function ensureRuntime(name: RuntimeName, options?: { install?: boolean }): Promise<RuntimeStatus> {
  const existing = await resolveRuntime(name)
  if (existing) return { name, available: true, path: existing }

  // npx ships with Node and is not something Vector should install behind the
  // user's back; a missing one means their Node install is broken.
  if (name === "npx" || options?.install === false) {
    return {
      name,
      available: false,
      error:
        name === "npx"
          ? "npx was not found. It ships with Node.js, so installing Node will provide it."
          : `${name} is not installed.`,
    }
  }

  const outcome = await installUv()
  if (!outcome.ok) return { name, available: false, error: outcome.error }

  const resolved = await resolveRuntime(name)
  if (!resolved) {
    return { name, available: false, error: "uv installed but its executable could not be found on PATH." }
  }
  return { name, available: true, path: resolved, installed: true }
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
