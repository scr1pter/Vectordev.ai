import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import type { WslDistroProbe, WslInstalledDistro, WslOnlineDistro, WslRuntimeCheck } from "../../preload/types"
import { wslTerminalArgs } from "./policy"
import { shellEscape, wslInstallScript, wslToolsProbeScript, wslResolveScript } from "./scripts"
export { shellEscape } from "./scripts"

export type WslCommandLine = {
  stream: "stdout" | "stderr"
  text: string
}

export type WslCommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

export type RunWslOptions = {
  signal?: AbortSignal
  /**
   * Ceiling on how long we wait for the child process to exit. When the
   * LXSS service or a specific distro wedges (e.g. Ubuntu-24.04 with a
   * pending first-run prompt), `wsl.exe` never returns and any command
   * that doesn't specify a timeout hangs the entire startup flow. Default
   * is 20s — enough for slow cold-starts, short enough to fail fast on
   * a wedge. Callers can override for longer-running jobs.
   */
  timeoutMs?: number
}

const DEFAULT_WSL_TIMEOUT_MS = 20_000
const DEFAULT_WSL_INSTALL_TIMEOUT_MS = 15 * 60_000
// The main process imports this module on every platform at startup, and @lydell/node-pty throws while loading when its
// platform package is missing or the wrong architecture. Load it only for the WSL installs that need a PTY, so a bad
// binary fails that one action instead of stopping Vector from opening.
const load = createRequire(import.meta.url)

export function wslArgs(args: string[], distro?: string | null, user?: string | null) {
  return [...(distro ? ["-d", distro] : []), ...(user ? ["--user", user] : []), "--", ...args]
}

export function runWsl(args: string[], opts: RunWslOptions = {}) {
  return runCommand("wsl", args, opts)
}

function runPowerShell(command: string, opts: RunWslOptions = {}) {
  return runCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    opts,
  )
}

function runCommand(command: string, args: string[], opts: RunWslOptions = {}) {
  return new Promise<WslCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      env: untrustedChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: opts.signal,
    })

    // Guard every wsl.exe invocation with a timeout. When the distro or
    // the LXSS service is wedged (Ubuntu first-run state, Windows update
    // pending, etc.) wsl.exe produces no output and never exits; without
    // this the whole sidecar spawn flow stalls the app forever.
    const timeoutMs = opts.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    let stdout = ""
    let stderr = ""
    const stdoutDecoder = createOutputDecoder()
    const stderrDecoder = createOutputDecoder()

    const append = (stream: WslCommandLine["stream"], chunk: string) => {
      if (!chunk) return
      if (stream === "stdout") {
        stdout += chunk
        return
      }
      stderr += chunk
    }

    child.stdout.on("data", (chunk: Buffer) => {
      append("stdout", stdoutDecoder.decode(chunk))
    })
    child.stdout.on("end", () => {
      append("stdout", stdoutDecoder.flush())
    })

    child.stderr.on("data", (chunk: Buffer) => {
      append("stderr", stderrDecoder.decode(chunk))
    })
    child.stderr.on("end", () => {
      append("stderr", stderrDecoder.flush())
    })

    child.once("error", (error) => {
      clearTimeout(timeoutId)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeoutId)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function runInteractiveCommand(command: string, args: string[], opts: RunWslOptions = {}, defaultTimeoutMs: number) {
  return new Promise<WslCommandResult>((resolve, reject) => {
    const pty: typeof import("@lydell/node-pty") = load("@lydell/node-pty")
    const child = pty.spawn(command, args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: untrustedChildEnvironment(),
      useConpty: true,
    })

    let settled = false
    let stdout = ""

    const cleanup = () => {
      clearTimeout(timeoutId)
      abortCleanup?.()
    }

    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs
    const timeoutId = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const abortHandler = () => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      if (settled) return
      settled = true
      cleanup()
      reject(new DOMException("Aborted", "AbortError"))
    }
    const abortCleanup = opts.signal
      ? (() => {
          opts.signal?.addEventListener("abort", abortHandler, { once: true })
          return () => opts.signal?.removeEventListener("abort", abortHandler)
        })()
      : undefined

    child.onData((data: string) => {
      stdout += data
    })
    child.onExit((event: { exitCode: number }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code: event.exitCode, signal: null, stdout, stderr: "" })
    })
  })
}

function createOutputDecoder() {
  let decoder: TextDecoder | undefined
  return {
    decode(chunk: Buffer) {
      decoder ??= new TextDecoder(detectOutputEncoding(chunk))
      return decoder.decode(chunk, { stream: true })
    },
    flush() {
      return decoder?.decode() ?? ""
    },
  }
}

function detectOutputEncoding(chunk: Uint8Array) {
  if (chunk[0] === 0xff && chunk[1] === 0xfe) return "utf-16le"
  const pairs = Math.floor(chunk.length / 2)
  if (pairs < 2) return "utf-8"
  const oddZeroes = Array.from({ length: pairs }).filter((_, index) => chunk[index * 2 + 1] === 0).length
  const evenZeroes = Array.from({ length: pairs }).filter((_, index) => chunk[index * 2] === 0).length
  return oddZeroes >= Math.ceil(pairs / 3) && evenZeroes * 2 <= oddZeroes ? "utf-16le" : "utf-8"
}

export function runWslInDistro(args: string[], distro?: string | null, opts?: RunWslOptions) {
  return runWsl(wslArgs(args, distro), opts)
}

export function runWslSh(script: string, distro?: string | null, opts?: RunWslOptions) {
  return runWslInDistro(["sh", "-lc", script], distro, opts)
}

export async function probeWslRuntime(opts?: RunWslOptions): Promise<WslRuntimeCheck> {
  const version = await runWsl(["--version"], opts).catch((error) => ({
    code: 1,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }))

  if (version.code !== 0) {
    return {
      available: false,
      version: null,
      error: summarize(version.stderr || version.stdout) || "WSL is unavailable",
    }
  }

  return {
    available: true,
    version: firstLine(version.stdout),
    error: null,
  }
}

export async function listInstalledWslDistros(opts?: RunWslOptions) {
  const result = await runWsl(["--list", "--verbose"], opts)
  if (result.code !== 0) {
    throw new Error(summarize(result.stderr || result.stdout) || "Failed to list installed WSL distros")
  }
  return parseInstalledDistros(result.stdout)
}

export async function listOnlineWslDistros(opts?: RunWslOptions) {
  const result = await runWsl(["--list", "--online"], opts)
  if (result.code !== 0) {
    throw new Error(summarize(result.stderr || result.stdout) || "Failed to list online WSL distros")
  }
  return parseOnlineDistros(result.stdout)
}

export async function installWslRuntimeElevated(opts?: RunWslOptions) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$process = Start-Process -FilePath 'wsl.exe' -Verb RunAs -ArgumentList @('--install','--no-distribution') -Wait -PassThru",
    "if ($null -ne $process.ExitCode) { exit $process.ExitCode }",
  ].join("; ")
  return runPowerShell(script, withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS))
}

export async function installWslDistro(name: string, opts?: RunWslOptions) {
  return runInteractiveCommand(
    resolveSystem32Command("wsl.exe"),
    ["--install", "-d", name, "--web-download", "--no-launch"],
    withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
    DEFAULT_WSL_INSTALL_TIMEOUT_MS,
  )
}

export async function installWslVector(version: string, distro: string, opts?: RunWslOptions) {
  return runInteractiveCommand(
    resolveSystem32Command("wsl.exe"),
    wslArgs(["bash", "-lc", wslInstallScript(version)], distro),
    withTimeout(opts, DEFAULT_WSL_INSTALL_TIMEOUT_MS),
    DEFAULT_WSL_INSTALL_TIMEOUT_MS,
  )
}

export async function probeWslDistro(name: string, opts?: RunWslOptions): Promise<WslDistroProbe> {
  const executable = await runWslInDistro(["/bin/true"], name, opts).catch((error) => ({
    code: 1,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }))
  if (executable.code !== 0) {
    return {
      name,
      canExecute: false,
      hasBash: false,
      hasInstallTools: false,
      error: summarize(executable.stderr || executable.stdout) || "Cannot execute commands in distro",
    }
  }

  const [bash, tools] = await Promise.all([
    runWslSh("command -v bash >/dev/null && printf yes || printf no", name, opts),
    runWslInDistro(["bash", "-lc", wslToolsProbeScript()], name, opts),
  ])

  return {
    name,
    canExecute: true,
    hasBash: bash.code === 0 && summarize(bash.stdout) === "yes",
    hasInstallTools: tools.code === 0 && summarize(tools.stdout) === "yes",
    error: null,
  }
}

export async function resolveWslVector(distro: string, opts?: RunWslOptions) {
  return firstLine((await runWslSh(wslResolveScript(), distro, opts)).stdout)
}

/**
 * How WSL networks a distro, for the Vector Local policy an engine there gets. `shared`: its 127.0.0.1 is Windows' own
 * (mirrored networking, or WSL 1). `nat` (WSL 2's default): it has a loopback of its own, and Windows is the default
 * gateway. `unknown`: the distro did not say.
 */
export type WslNetwork = { readonly mode: "shared" | "nat" | "unknown"; readonly gateway?: string }

// wslinfo comes with WSL 2.0, the release that added mirrored networking, so a WSL 2 kernel without it is NAT.
const WSL_NETWORK_SCRIPT = [
  'printf "mode=%s\\n" "$(wslinfo --networking-mode 2>/dev/null || true)"',
  'printf "kernel=%s\\n" "$(uname -r 2>/dev/null || true)"',
  "ip route show default 2>/dev/null || true",
].join("\n")

/** How WSL networks `distro`, read inside it. A distro that does not answer is `unknown`. */
export async function wslNetwork(distro: string, opts?: RunWslOptions): Promise<WslNetwork> {
  const result = await runWslSh(WSL_NETWORK_SCRIPT, distro, opts).catch(() => undefined)
  return parseWslNetwork(result?.stdout ?? "")
}

/** Reads WSL_NETWORK_SCRIPT's output: wslinfo's networking mode, the kernel release and the default route. */
export function parseWslNetwork(stdout: string): WslNetwork {
  const mode = /^mode=(.*)$/m.exec(stdout)?.[1]?.trim().toLowerCase() ?? ""
  const kernel = /^kernel=(.*)$/m.exec(stdout)?.[1]?.trim() ?? ""
  const route = /^default via (\d{1,3}(?:\.\d{1,3}){3})\b/m.exec(stdout)?.[1]
  // The gateway WSL gives a distro is a private address of the Windows host; anything else is not taken for it.
  const gateway = route && LocalPolicy.hostClass(route) === "your-network" ? route : undefined
  const wsl2 = /microsoft-standard-wsl2/i.test(kernel)
  if (mode === "mirrored" || (!wsl2 && /microsoft/i.test(kernel))) return { mode: "shared" }
  if (mode === "nat" || (wsl2 && !mode)) return gateway ? { mode: "nat", gateway } : { mode: "nat" }
  return { mode: "unknown" }
}

/**
 * The desktop's Vector Local for an engine it starts in WSL, as VECTOR_LOCAL_POLICY: on, its Web access and its model
 * servers. It is user-level policy (LocalPolicy.resolve reads it so), so it can only turn Vector Local on, tighten Web
 * access and add servers there; it never carries a lock, the services or sites the desktop allows, or a company's
 * wildcard and address-range entries, which apply on Windows only. A distro needs its own /etc/vector/vector.json for
 * those. In NAT networking a server on Windows' 127.0.0.1 is at the gateway from inside the distro, so each server on
 * this computer is listed there too. Undefined while Vector Local is off.
 */
export function wslLocalPolicy(policy: LocalMode.Policy, network: WslNetwork) {
  if (!policy.enabled) return undefined
  const origins = policy.endpoints.flatMap((item) => {
    const origin = item.origin.includes("*") ? undefined : LocalPolicy.origin(item.origin)
    return origin ? [origin] : []
  })
  const gateway = network.mode === "nat" ? network.gateway : undefined
  const windows = gateway
    ? origins
        .filter((origin) => LocalPolicy.loopback(new URL(origin).hostname))
        .map((origin) => {
          const url = new URL(origin)
          url.hostname = gateway
          return url.origin
        })
    : []
  return JSON.stringify({ enabled: true, web: policy.web, endpoints: [...new Set([...origins, ...windows])] })
}

export async function readWslCommandVersion(command: string, distro: string, opts?: RunWslOptions) {
  const result = await runWslSh(`VECTOR_CLI=1 ${shellEscape(command)} --version 2>/dev/null || true`, distro, opts)
  return firstLine(result.stdout)
}

export function openWslTerminal(distro?: string | null) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(resolveSystem32Command("wsl.exe"), wslTerminalArgs(distro), {
      detached: true,
      env: untrustedChildEnvironment(),
      stdio: "ignore",
      windowsHide: false,
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

function parseInstalledDistros(output: string) {
  return output.split(/\r?\n/g).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    const match = line.match(/^\s*(\*)?\s*(.*?)\s{2,}\S+\s+(\d+)\s*$/)
    if (!match) return []
    const [, marker, name, version] = match
    if (!name || /^name$/i.test(name)) return []
    return [
      {
        name: name.trim(),
        version: Number.isNaN(Number.parseInt(version, 10)) ? null : Number.parseInt(version, 10),
        isDefault: marker === "*",
      } satisfies WslInstalledDistro,
    ]
  })
}

function parseOnlineDistros(output: string) {
  return output.split(/\r?\n/g).flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed) return []
    const match = trimmed.match(/^([A-Za-z0-9._-]+)\s{2,}(.+)$/)
    if (!match) return []
    const [, name, label] = match
    if (/^name$/i.test(name)) return []
    return [{ name, label: label.trim() } satisfies WslOnlineDistro]
  })
}

function firstLine(value: string) {
  return (
    value
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  )
}

export function summarize(value: string) {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

function resolveSystem32Command(command: string) {
  const root = process.env.SystemRoot ?? process.env.windir
  if (!root) return command
  const resolved = join(root, "System32", command)
  return existsSync(resolved) ? resolved : command
}

function withTimeout(opts: RunWslOptions | undefined, timeoutMs: number): RunWslOptions {
  return {
    ...opts,
    timeoutMs: opts?.timeoutMs ?? timeoutMs,
  }
}
