import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { getUserShell, loadShellEnv } from "./shell-env"

// Detection + handoff plumbing for external coding agents/editors Vector can
// host or hand a task off to. Read-only probing (no shell:true, fixed
// binaries) so this never executes anything the user didn't already install.

export type ExternalAgentId = "claude-code" | "codex" | "cursor" | "vscode"
export type CodingAgentRuntime = "claude-code" | "codex" | "cursor"

export type ExternalAgentStatus = {
  id: ExternalAgentId
  name: string
  cli: string
  installed: boolean
  version?: string
  path?: string
}

type ExternalAgentCandidate = { id: ExternalAgentId; name: string; cli: string }

const CANDIDATES: ExternalAgentCandidate[] = [
  { id: "claude-code", name: "Claude Code", cli: "claude" },
  { id: "codex", name: "Codex CLI", cli: "codex" },
  { id: "cursor", name: "Cursor Agent", cli: "cursor-agent" },
  { id: "vscode", name: "VS Code", cli: "code" },
]

// Mirrors packages/app/src/features/agents/external-runtimes.ts, which the
// renderer shows as setup steps. The app package does not export that module to
// the main process, so the two lists have to be kept in sync by hand.
const RUNTIME_SETUP: Record<CodingAgentRuntime, { label: string; cli: string; install: string; signIn: string }> = {
  "claude-code": {
    label: "Claude Code",
    cli: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    signIn: "claude",
  },
  codex: { label: "Codex", cli: "codex", install: "npm install -g @openai/codex", signIn: "codex" },
  cursor: {
    label: "Cursor Agent",
    cli: "cursor-agent",
    install: "curl https://cursor.com/install -fsS | bash",
    signIn: "cursor-agent login",
  },
}

export type AgentEnvironment = Record<string, string | undefined>

// A macOS app launched from Finder or the Dock inherits a bare PATH
// (/usr/bin:/bin:/usr/sbin:/sbin), so a CLI installed through nvm, fnm, mise,
// asdf, volta, pnpm or an npm prefix is invisible to Vector even though it runs
// fine in the user's terminal. Probe the login shell once — the same mechanism
// the engine sidecar uses in server.ts — and use it for detection *and* for
// spawning, so a runtime Vector can see is a runtime Vector can actually run.
let environment: AgentEnvironment | undefined

export function agentEnvironment(): AgentEnvironment {
  if (environment) return environment
  // loadShellEnv spawns the login shell synchronously, so this must happen once
  // per process rather than once per detection or per run.
  const loaded = process.platform === "win32" ? null : loadShellEnv(getUserShell(), console)
  const separator = pathSeparator(process.platform)
  environment = {
    ...process.env,
    ...loaded,
    // Union rather than replacement: the login shell knows where the user's
    // tools live, the app environment knows what Electron's own helpers need.
    PATH: [...new Set([...(loaded?.PATH ?? "").split(separator), ...(process.env.PATH ?? "").split(separator)])]
      .filter(Boolean)
      .join(separator),
  }
  return environment
}

function pathSeparator(platform: NodeJS.Platform) {
  return platform === "win32" ? ";" : ":"
}

export function executableNames(cli: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return [cli]
  // npm, pnpm and yarn install Windows CLIs as shims. `.exe` comes first because
  // Node can spawn it directly; a shim needs cmd.exe (see shimmedCommand).
  return [`${cli}.exe`, `${cli}.cmd`, `${cli}.bat`, `${cli}.ps1`, cli]
}

// Every path Vector will look at for `cli`, in preference order: the user's own
// PATH first, then the places package and version managers actually install to.
export async function agentCandidatePaths(
  cli: string,
  env: AgentEnvironment = agentEnvironment(),
  platform: NodeJS.Platform = process.platform,
) {
  const directories = new Set([
    ...(env.PATH ?? "").split(pathSeparator(platform)).filter(Boolean),
    ...installDirectories(cli, env, platform),
    ...(await versionDirectories(env, platform)),
  ])
  return [...directories].flatMap((directory) => executableNames(cli, platform).map((name) => join(directory, name)))
}

async function isExecutableFile(path: string) {
  const executable = await access(path, constants.X_OK)
    .then(() => true)
    .catch(() => false)
  if (!executable) return false
  // access(X_OK) also succeeds for a directory, so a folder that happens to be
  // named `code` (or `claude`) on PATH would otherwise be reported as an
  // installed CLI and then fail to spawn. stat follows symlinks, so the usual
  // homebrew/npm symlink-to-binary still counts as a file.
  return await stat(path)
    .then((stats) => stats.isFile())
    .catch(() => false)
}

export async function resolveAgentPath(
  cli: string,
  env: AgentEnvironment = agentEnvironment(),
  platform: NodeJS.Platform = process.platform,
) {
  const candidates = await agentCandidatePaths(cli, env, platform)
  // Checked in parallel — a serial walk over this many directories is slow
  // enough to show up in the picker — but order still decides the winner.
  const found = await Promise.all(candidates.map(async (path) => ((await isExecutableFile(path)) ? path : undefined)))
  return found.find((path): path is string => Boolean(path))
}

function installDirectories(cli: string, env: AgentEnvironment, platform: NodeJS.Platform) {
  const home = env.HOME || env.USERPROFILE || homedir()
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
      join(home, ".cursor", "bin"),
      ...cursorBundleDirectories(cli, [join(localAppData, "Programs", "cursor", "resources", "app", "bin")]),
      join(localAppData, "Programs", "Microsoft VS Code", "bin"),
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
    join(home, ".cursor", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/local/bin",
    "/snap/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    // Editors ship their shell command inside the bundle, and the ChatGPT app
    // ships codex.
    ...(platform === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin",
          ...cursorBundleDirectories(cli, ["/Applications/Cursor.app/Contents/Resources/app/bin"]),
          "/Applications/ChatGPT.app/Contents/Resources",
        ]
      : []),
  ].filter((directory): directory is string => Boolean(directory))
}

// Cursor's bundle ships its own `code` command alongside `cursor`. Searching the
// bundle for `code` reports "VS Code installed" — at Cursor's version number —
// on a machine that has no VS Code, and then opens Cursor when the user picks
// VS Code. Ordering VS Code first only helps when both are installed, so the
// bundle answers for Cursor's own commands only. A `code` the user deliberately
// installed onto PATH still wins, because PATH is searched first.
function cursorBundleDirectories(cli: string, directories: string[]) {
  return cli === "code" ? [] : directories
}

// Version managers install one bin directory per runtime version, so the roots
// are listed once (one readdir each, in parallel) instead of guessing versions.
async function versionDirectories(env: AgentEnvironment, platform: NodeJS.Platform) {
  const home = env.HOME || env.USERPROFILE || homedir()
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
  return (
    await Promise.all(
      roots.map(async (entry) =>
        (await readdir(entry.root).catch(() => [])).map((version) => join(entry.root, version, ...entry.leaf)),
      ),
    )
  ).flat()
}

type RunResult = { stdout: string; stderr: string; failed: boolean }

function run(command: string, args: string[], timeoutMs: number, env?: AgentEnvironment) {
  return new Promise<RunResult>((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) })
    })
  })
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

async function detectOne(candidate: ExternalAgentCandidate): Promise<ExternalAgentStatus> {
  const path = await resolveAgentPath(candidate.cli)
  if (!path) return { id: candidate.id, name: candidate.name, cli: candidate.cli, installed: false }
  // Node-based CLIs are shims that need their own runtime on PATH, so the
  // version probe gets the same environment the real run will get.
  const result = await run(path, ["--version"], 5_000, agentEnvironment())
  const version = result.failed ? undefined : (firstLine(result.stdout) ?? firstLine(result.stderr))
  return { id: candidate.id, name: candidate.name, cli: candidate.cli, installed: true, version, path }
}

// Detection touches the filesystem and spawns a `--version` probe per candidate;
// cache the result briefly so a re-render (or several) doesn't repeat the work.
const CACHE_TTL_MS = 60_000
let cache: { at: number; result: ExternalAgentStatus[] } | undefined

export async function detectExternalAgents(): Promise<ExternalAgentStatus[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result
  const result = await Promise.all(CANDIDATES.map(detectOne))
  cache = { at: Date.now(), result }
  return result
}

export type OpenInEditorApp = "cursor" | "vscode"

export type OpenInEditorInput = { app: OpenInEditorApp; path: string }

export type OpenInEditorResult = { ok: boolean; error?: string }

const EDITOR_CLIS: Record<OpenInEditorApp, string> = { cursor: "cursor", vscode: "code" }

// Node refuses to run a .cmd/.bat shim directly (the CVE-2024-27980 fix) and
// every Windows install ships one — npm's global CLIs, and VS Code's and
// Cursor's own `bin\code.cmd` — so those go through cmd.exe with an
// already-quoted command line. shell:true would re-split the prompt.
export function shimmedCommand(path: string, args: string[], platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(path)) {
    return { command: path, args, windowsVerbatimArguments: false }
  }
  const quoted = [path, ...args].map((value) => `"${value.replace(/"/g, '""')}"`).join(" ")
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${quoted}"`],
    windowsVerbatimArguments: true,
  }
}

export async function openInEditor(input: OpenInEditorInput): Promise<OpenInEditorResult> {
  const path = input?.path?.trim()
  if (!path) return { ok: false, error: "Choose a file or folder to open." }
  const stats = await stat(path).catch(() => undefined)
  if (!stats) return { ok: false, error: `"${path}" does not exist.` }

  const cli = EDITOR_CLIS[input.app]
  const executable = await resolveAgentPath(cli)
  if (!executable) return { ok: false, error: `Couldn't find the \`${cli}\` command. Install its shell command first.` }
  const launch = shimmedCommand(executable, [path])
  return new Promise((resolve) => {
    // The cursor/code CLIs hand off to the editor app and exit almost
    // immediately, so the launched editor never becomes Vector's child.
    const child = execFile(
      launch.command,
      launch.args,
      {
        timeout: 10_000,
        env: agentEnvironment(),
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
      (error: Error | null) => {
        resolve(error ? { ok: false, error: `Couldn't launch ${cli}. ${error.message}` } : { ok: true })
      },
    )
    child.unref()
  })
}

// Directories that never belong in an isolated agent checkout — heavyweight or
// machine-specific state that a headless agent should regenerate itself.
const WORKSPACE_EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".vercel",
])

const RUNS_DIRECTORY_NAME = "external-agent-runs"

export type PrepareWorkspaceResult = { path: string; isolation: "git-worktree" | "copy" }

function runIn(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<RunResult>((resolve) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) })
    })
  })
}

async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const result = await runIn("git", ["rev-parse", "--show-toplevel"], cwd, 5_000)
  if (result.failed) return undefined
  return firstLine(result.stdout)
}

async function gitTreeClean(cwd: string): Promise<boolean> {
  const result = await runIn("git", ["status", "--porcelain"], cwd, 5_000)
  return !result.failed && result.stdout.trim().length === 0
}

async function copyProjectTree(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, {
    recursive: true,
    dereference: false,
    filter: (entry) => !entry.split(/[\\/]/).some((part) => WORKSPACE_EXCLUDED_DIRS.has(part)),
  })
}

// Create an isolated working directory for a single external-agent run so the
// headless agent edits a checkout, never the user's live project. Prefers a git
// worktree (cheap, shares history) when the tree is a clean repo, and falls back
// to an excluded-dir copy for non-git or dirty trees — mirrors the isolation
// strategy in parallel-workspaces.ts, kept minimal for a one-shot run.
export async function prepareWorkspace(projectPath: string): Promise<PrepareWorkspaceResult> {
  const path = projectPath?.trim()
  if (!path) throw new Error("Open a project before running an external agent.")
  const stats = await stat(path).catch(() => undefined)
  if (!stats?.isDirectory()) throw new Error(`"${path}" is not a folder Vector can run an agent in.`)

  // Imported here so detection and run classification stay testable outside
  // Electron; the runs directory is the only thing in this file that needs app.
  const { app } = await import("electron")
  const runId = randomUUID()
  const runRoot = join(app.getPath("userData"), RUNS_DIRECTORY_NAME, runId)
  const isolatedPath = join(runRoot, "workspace")
  await mkdir(runRoot, { recursive: true })

  const gitRoot = await gitTopLevel(path)
  if (gitRoot && (await gitTreeClean(gitRoot))) {
    const branch = `vector-agent/${runId.slice(0, 8)}`
    const worktree = await runIn("git", ["worktree", "add", "-b", branch, isolatedPath, "HEAD"], gitRoot, 30_000)
    if (!worktree.failed) return { path: isolatedPath, isolation: "git-worktree" }
    // A failed worktree can leave a partial checkout behind; clear it before
    // falling back to a plain copy so the copy starts from a clean directory.
    await rm(isolatedPath, { recursive: true, force: true }).catch(() => undefined)
  }

  await copyProjectTree(gitRoot ?? path, isolatedPath)
  return { path: isolatedPath, isolation: "copy" }
}

export type ExternalAgentEvent = {
  stream: "activity" | "stdout" | "stderr"
  text: string
}

export type ExternalAgentRunResult = {
  exitCode: number
  summary: string
  error?: string
  actualCost?: string
  output: string[]
}

export type RunExternalAgentInput = {
  runtime: CodingAgentRuntime
  cwd: string
  prompt: string
  signal?: AbortSignal
  onEvent?: (event: ExternalAgentEvent) => void
}

const SECRET_VALUE_PATTERN =
  /((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*["'=:\s]+\s*)([^\s"',}]+)/gi
const BEARER_PATTERN = /(bearer\s+)[a-z0-9._~+/=-]+/gi

function redactAgentOutput(value: string) {
  return value.replace(SECRET_VALUE_PATTERN, "$1[redacted]").replace(BEARER_PATTERN, "$1[redacted]")
}

function runtimeArguments(runtime: CodingAgentRuntime, cwd: string, prompt: string) {
  if (runtime === "claude-code") {
    return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]
  }
  if (runtime === "codex") {
    return ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", cwd, prompt]
  }
  return ["-p", "--force", "--output-format", "stream-json", prompt]
}

function parseAgentJson(line: string) {
  const body = line.replace(/^\[(?:stdout|stderr)\]\s+/, "")
  if (!body.startsWith("{")) return undefined
  try {
    const value = JSON.parse(body)
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function textAt(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") return undefined
  return keys
    .map((key) => (value as Record<string, unknown>)[key])
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function activityFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  if (!event) return line
  const type = typeof event.type === "string" ? event.type : "event"
  const item = event.item && typeof event.item === "object" ? event.item : undefined
  const message =
    textAt(event, ["result", "message", "summary", "text"]) ??
    textAt(item, ["text", "message", "command", "path", "name"])
  return message ? `${type}: ${message}` : type.replace(/[._-]+/g, " ")
}

function summaryFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  if (!event) return undefined
  return (
    textAt(event, ["result", "summary", "final_output"]) ??
    (event.item && typeof event.item === "object" ? textAt(event.item, ["text", "message"]) : undefined)
  )
}

function costFromAgentLine(line: string) {
  const event = parseAgentJson(line)
  const value = event?.total_cost_usd ?? event?.cost_usd
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : undefined
}

// What a signed-out CLI says instead of doing the work. Only ever matched
// against a line the runtime already flagged as an error, so a file the agent
// happens to edit that mentions "unauthorized" can't trip it.
const SIGNED_OUT_PATTERN =
  /not logged ?in|not (?:signed|authenticated)|log ?in required|login required|please run \/?login|run `?[\w-]+ login|unauthorized|\b401\b|invalid api key|no credentials|credentials (?:are )?(?:missing|expired)|(?:token|session) (?:has )?expired/i

export type AgentOutcome = { exitCode: number; error?: string }

// The exit code alone does not decide whether a run worked: Claude Code exits 0
// while reporting {"type":"result","subtype":"success","is_error":true,
// "result":"Not logged in · Please run /login"}, which used to be recorded as a
// successful pass that changed nothing.
export function agentOutcome(runtime: CodingAgentRuntime, exitCode: number, output: string[]): AgentOutcome {
  const setup = RUNTIME_SETUP[runtime]
  const reported = output
    .map((line) => {
      const event = parseAgentJson(line)
      if (!event || event.is_error !== true) return undefined
      return textAt(event, ["result", "error", "message", "summary"]) ?? `${setup.label} reported an error.`
    })
    .find((text): text is string => Boolean(text))
  const failed = exitCode !== 0 || Boolean(reported)
  if (!failed) return { exitCode }

  const stderr = output.filter((line) => line.startsWith("[stderr] ")).join("\n")
  const evidence = reported ?? stderr
  if (SIGNED_OUT_PATTERN.test(evidence)) {
    return {
      exitCode: exitCode === 0 ? 1 : exitCode,
      error: `${setup.label} is installed but not signed in${reported ? ` (${reported})` : ""}. Run \`${setup.signIn}\` in a terminal to sign in, then run this again.`,
    }
  }
  return {
    exitCode: exitCode === 0 ? 1 : exitCode,
    error: reported ?? `${setup.label} exited with code ${exitCode}.`,
  }
}

function stopAgentProcess(child: ChildProcessWithoutNullStreams) {
  if (child.killed) return
  if (process.platform === "win32") {
    child.kill("SIGTERM")
    return
  }
  if (!child.pid) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

export async function runExternalCodingAgent(input: RunExternalAgentInput): Promise<ExternalAgentRunResult> {
  const setup = RUNTIME_SETUP[input.runtime]
  const env = agentEnvironment()
  const path = await resolveAgentPath(setup.cli, env)
  if (!path) {
    throw new Error(
      `${setup.label} is not installed, or Vector can't find it. Install it with \`${setup.install}\`, then sign in with \`${setup.signIn}\`.`,
    )
  }

  return new Promise((resolve, reject) => {
    const launch = shimmedCommand(path, runtimeArguments(input.runtime, input.cwd, input.prompt))
    const child = spawn(launch.command, launch.args, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    })
    const output: string[] = []
    const summaries: string[] = []
    let actualCost: string | undefined
    let stdoutBuffer = ""
    let stderrBuffer = ""
    let settled = false

    const emitLine = (stream: "stdout" | "stderr", raw: string) => {
      const text = redactAgentOutput(raw.trim())
      if (!text) return
      output.push(`[${stream}] ${text}`)
      if (output.length > 240) output.shift()
      const summary = summaryFromAgentLine(text)
      if (summary) summaries.push(summary)
      actualCost = costFromAgentLine(text) ?? actualCost
      input.onEvent?.({ stream, text })
      input.onEvent?.({ stream: "activity", text: activityFromAgentLine(text) })
    }

    const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const combined = (stream === "stdout" ? stdoutBuffer : stderrBuffer) + chunk.toString("utf8")
      const lines = combined.split(/\r?\n/)
      const remainder = lines.pop() ?? ""
      if (stream === "stdout") stdoutBuffer = remainder
      if (stream === "stderr") stderrBuffer = remainder
      lines.forEach((line) => emitLine(stream, line))
    }

    const abort = () => stopAgentProcess(child)
    input.signal?.addEventListener("abort", abort, { once: true })
    child.stdin.end()
    if (input.signal?.aborted) abort()
    child.stdout.on("data", (chunk: Buffer) => consume("stdout", chunk))
    child.stderr.on("data", (chunk: Buffer) => consume("stderr", chunk))
    child.once("error", (error) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener("abort", abort)
      reject(error)
    })
    child.once("close", (code) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener("abort", abort)
      emitLine("stdout", stdoutBuffer)
      emitLine("stderr", stderrBuffer)
      const outcome = agentOutcome(input.runtime, code ?? (input.signal?.aborted ? 130 : 1), output)
      resolve({
        exitCode: outcome.exitCode,
        summary: outcome.error ?? summaries.at(-1) ?? `${setup.label} completed the isolated task.`,
        error: outcome.error,
        actualCost,
        output,
      })
    })
  })
}
