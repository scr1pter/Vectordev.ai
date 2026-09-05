import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { basename, join } from "node:path"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"

// Each probe gets at most PROBE_TIMEOUT, and together they never hold startup
// past TOTAL_TIMEOUT. A `-il` probe that hangs (a .zshrc waiting on a prompt, a
// plugin manager fetching updates) still leaves the `-l` probe a few seconds to
// recover PATH from the profile files alone, which is where version managers
// usually put it.
const PROBE_TIMEOUT = 5_000
const TOTAL_TIMEOUT = 8_000
const MIN_PROBE_TIMEOUT = 500

type Probe = { type: "Loaded"; value: Record<string, string> } | { type: "Timeout" } | { type: "Unavailable" }
type ShellEnvLogger = {
  log: (message: string) => void
}
export type PathEnvironment = Record<string, string | undefined>

export function resolveUserShell(envShell: string | undefined, loginShell: string | null | undefined) {
  const resolvedLoginShell = loginShell && loginShell !== "unknown" ? loginShell : undefined
  return envShell || resolvedLoginShell || "/bin/sh"
}

export function getUserShell() {
  try {
    return resolveUserShell(process.env.SHELL, userInfo().shell)
  } catch {
    return resolveUserShell(process.env.SHELL, undefined)
  }
}

export function parseShellEnv(out: Buffer) {
  const env: Record<string, string> = {}
  for (const line of out.toString("utf8").split("\0")) {
    if (!line) continue
    const ix = line.indexOf("=")
    if (ix <= 0) continue
    env[line.slice(0, ix)] = line.slice(ix + 1)
  }
  return env
}

function probe(shell: string, mode: "-il" | "-l", timeout: number): Probe {
  const out = spawnSync(shell, [mode, "-c", "env -0"], {
    env: untrustedChildEnvironment(),
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
    windowsHide: true,
  })

  const err = out.error as NodeJS.ErrnoException | undefined
  if (err) {
    if (err.code === "ETIMEDOUT") return { type: "Timeout" }
    console.log(`[server] Shell env probe failed for ${shell} ${mode}: ${err.message}`)
    return { type: "Unavailable" }
  }

  if (out.status !== 0) {
    console.log(`[server] Shell env probe exited with non-zero status for ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  const env = parseShellEnv(out.stdout)
  if (Object.keys(env).length === 0) {
    console.log(`[server] Shell env probe returned empty env for ${shell} ${mode}`)
    return { type: "Unavailable" }
  }

  return { type: "Loaded", value: env }
}

export function isNushell(shell: string) {
  const name = basename(shell).toLowerCase()
  const raw = shell.toLowerCase()
  return name === "nu" || name === "nu.exe" || raw.endsWith("\\nu.exe")
}

export function loadShellEnv(shell: string, logger: ShellEnvLogger) {
  if (isNushell(shell)) {
    logger.log(`[server] Skipping shell env probe for nushell: ${shell}`)
    return null
  }

  const deadline = Date.now() + TOTAL_TIMEOUT
  const interactive = probe(shell, "-il", PROBE_TIMEOUT)
  if (interactive.type === "Loaded") {
    logger.log(`[server] Loaded shell environment with -il (${Object.keys(interactive.value).length} vars)`)
    return interactive.value
  }
  if (interactive.type === "Timeout") {
    // Not a reason to give up: the hang almost always lives in the rc files
    // an interactive shell reads, and a login-only shell skips them.
    logger.log(`[server] Interactive shell env probe timed out, retrying as a login shell: ${shell}`)
  }

  const budget = Math.min(PROBE_TIMEOUT, deadline - Date.now())
  if (budget < MIN_PROBE_TIMEOUT) {
    logger.log(`[server] Falling back to app environment, shell probes out of time: ${shell}`)
    return null
  }
  const login = probe(shell, "-l", budget)
  if (login.type === "Loaded") {
    logger.log(`[server] Loaded shell environment with -l (${Object.keys(login.value).length} vars)`)
    return login.value
  }

  logger.log(`[server] Falling back to app environment: ${shell}`)
  return null
}

export function mergeShellEnv(shell: Record<string, string> | null, env: Record<string, string>) {
  return {
    ...shell,
    ...env,
  }
}

export function pathDelimiter(platform: NodeJS.Platform = process.platform) {
  return platform === "win32" ? ";" : ":"
}

// Union in order, first occurrence wins. Entries may be whole PATH strings or
// single directories; a directory never contains its platform's delimiter, so
// splitting everything is safe.
export function unionPath(entries: Array<string | undefined>, platform: NodeJS.Platform = process.platform) {
  const delimiter = pathDelimiter(platform)
  const directories = new Set<string>()
  for (const entry of entries) {
    for (const directory of (entry ?? "").split(delimiter)) {
      if (directory) directories.add(directory)
    }
  }
  return [...directories].join(delimiter)
}

function homeOf(env: PathEnvironment) {
  return env.HOME || env.USERPROFILE || homedir()
}

// Where package managers and tool installers put executables. A macOS app
// launched from Finder or the Dock inherits /usr/bin:/bin:/usr/sbin:/sbin, so
// when the login-shell probe cannot tell us where the user's tools live these
// are the places worth looking on their behalf.
export function toolBinDirectories(env: PathEnvironment = process.env, platform: NodeJS.Platform = process.platform) {
  const home = homeOf(env)
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming")
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local")
    return [
      join(appData, "npm"),
      // npm's Windows prefix holds the shims directly, every other manager uses bin/.
      env.npm_config_prefix,
      env.PNPM_HOME,
      join(localAppData, "pnpm"),
      join(env.VOLTA_HOME || join(localAppData, "Volta"), "bin"),
      join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
      join(home, ".local", "bin"),
      join(home, ".deno", "bin"),
      join(home, ".cargo", "bin"),
    ].filter((directory): directory is string => Boolean(directory))
  }
  return [
    join(home, ".local", "bin"),
    join(home, "bin"),
    env.NVM_BIN,
    join(env.BUN_INSTALL || join(home, ".bun"), "bin"),
    join(env.VOLTA_HOME || join(home, ".volta"), "bin"),
    env.PNPM_HOME,
    join(home, "Library", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    env.npm_config_prefix ? join(env.npm_config_prefix, "bin") : undefined,
    join(home, ".npm-global", "bin"),
    join(home, ".npm-packages", "bin"),
    join(home, ".yarn", "bin"),
    join(home, ".config", "yarn", "global", "node_modules", ".bin"),
    // mise and asdf put a shim for every installed tool in one directory, which
    // is cheaper to find than walking their per-version installs.
    join(env.MISE_DATA_DIR || join(home, ".local", "share", "mise"), "shims"),
    join(env.ASDF_DATA_DIR || join(home, ".asdf"), "shims"),
    join(home, ".deno", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/local/bin",
    "/snap/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ].filter((directory): directory is string => Boolean(directory))
}

// Version managers install one bin directory per runtime version, so the roots
// are listed once instead of guessing versions. Newest version first, so a
// fallback `node` is the one the user most likely made their default.
export function versionManagerBinDirectories(
  env: PathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  const home = homeOf(env)
  const roots =
    platform === "win32"
      ? [
          {
            root: join(env.APPDATA || join(home, "AppData", "Roaming"), "fnm", "node-versions"),
            leaf: ["installation"],
          },
          {
            root: join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "fnm", "node-versions"),
            leaf: ["installation"],
          },
        ]
      : [
          { root: join(env.NVM_DIR || join(home, ".nvm"), "versions", "node"), leaf: ["bin"] },
          { root: join(env.FNM_DIR || join(home, ".fnm"), "node-versions"), leaf: ["installation", "bin"] },
          { root: join(home, ".local", "share", "fnm", "node-versions"), leaf: ["installation", "bin"] },
          { root: join(env.MISE_DATA_DIR || join(home, ".local", "share", "mise"), "installs", "node"), leaf: ["bin"] },
          { root: join(env.ASDF_DATA_DIR || join(home, ".asdf"), "installs", "nodejs"), leaf: ["bin"] },
        ]
  return roots.flatMap((entry) => {
    let versions: string[]
    try {
      versions = readdirSync(entry.root)
    } catch {
      return []
    }
    return versions
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(entry.root, version, ...entry.leaf))
  })
}

// Every directory a child process should be able to find node/npx/bun in when
// the shell probe gave us nothing. Appended after the real PATH, never in front
// of it, so the user's own ordering still wins whenever it is known.
export function fallbackBinDirectories(
  env: PathEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
) {
  return [...new Set([...toolBinDirectories(env, platform), ...versionManagerBinDirectories(env, platform)])]
}
