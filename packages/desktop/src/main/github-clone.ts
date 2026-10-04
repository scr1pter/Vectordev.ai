import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { rmSync } from "node:fs"
import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, posix, win32 } from "node:path"
import { StringDecoder } from "node:string_decoder"
import electron from "electron"
import type { BrowserWindow, OpenDialogOptions } from "electron"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

import { buildOauthPushHeader, parseGithubRemote } from "./github"
import { apiHeaders, getGithubToken, logoutGithub } from "./github-auth"
import { resolveAgentPath, signalAgentProcess, stopAgentProcess, type AgentEnvironment } from "./external-agents"
import { redactText } from "./security-redaction"
import { getStore } from "./store"
import { GITHUB_CLONE_PARENT_KEY } from "./store-keys"

// "Open from GitHub": clone a github.com repository with the system git, then the renderer opens the folder the same
// way Open Project does. The renderer never names a destination path. It sends one validated folder name and echoes
// the parent folder main gave it, which is either the fixed OS default or a folder the user chose in a native picker
// opened here. The GitHub token reaches git only through the child's environment for this one clone: never argv, the
// remote URL, .git/config, logs, progress events or error text.

export type GithubCloneRepo = { owner: string; name: string }
export type GithubCloneParse = { ok: true; repo: GithubCloneRepo } | { ok: false; error: string }
export type GithubCloneParent = { path: string; isDefault: boolean }
export type GithubCloneInput = { runId: string; repo: string; folder: string; parent: string }
export type GithubClonePhase = "starting" | "receiving" | "resolving" | "checkout"
export type GithubCloneProgress = { runId: string; phase: GithubClonePhase; percent: number; message: string }
export type GithubCloneErrorKind =
  | "invalid"
  | "busy"
  | "exists"
  | "git-missing"
  | "git-outdated"
  | "auth"
  | "not-found"
  | "network"
  | "disk"
  | "canceled"
  | "failed"
export type GithubCloneResult =
  | { ok: true; directory: string; reused: boolean; fullName: string }
  | { ok: false; kind: GithubCloneErrorKind; error: string; detail?: string; suggestedFolder?: string }

export type GithubRepositoryLookup =
  | { ok: true; repo: GithubCloneRepo; private?: boolean }
  | { ok: false; kind: "auth" | "not-found"; error: string; expired?: boolean }

export type GithubCloneDeps = {
  sender: number
  emit: (progress: GithubCloneProgress) => void
  log?: (line: string) => void
  // Test seams. Production uses the app environment, finds git on its PATH, reads the remembered parent and the
  // stored token, and asks the GitHub API about the repository.
  environment?: AgentEnvironment
  git?: string
  parent?: () => Promise<GithubCloneParent>
  token?: () => Promise<string | undefined>
  lookup?: (repo: GithubCloneRepo, token?: string) => Promise<GithubRepositoryLookup>
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
// No leading "-", so a name can never read as an option even before the "--" in the clone command.
const NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/
const RUN_ID = /^[A-Za-z0-9-]{1,100}$/
const XCRUN = /xcrun: error|invalid active developer path/i
const PROGRESS =
  /^(?:remote:\s*)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Filtering content):\s+(\d{1,3})%/
const PHASES = {
  "Counting objects": ["starting", 0, 5],
  "Compressing objects": ["starting", 0, 5],
  "Receiving objects": ["receiving", 5, 80],
  "Resolving deltas": ["resolving", 80, 95],
  "Updating files": ["checkout", 95, 100],
  "Filtering content": ["checkout", 95, 100],
} as const
// Variables that only point git at the user's certificates, SSH setup or config files survive; every other GIT_*
// variable (askpass, inherited GIT_CONFIG_*, traces that would print the header, GIT_DIR) is dropped.
const KEEP = new Set([
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
])

const MESSAGES = {
  emptySource: "Enter a repository as owner/name or paste its github.com link.",
  credentials: "Remove the username or token from the link. Vector uses your GitHub sign-in instead.",
  otherHost:
    "Vector can only clone repositories from github.com. Paste a link like https://github.com/owner/name or type owner/name.",
  invalidRepo: "That isn't a valid GitHub repository. Use owner/name, for example octocat/Hello-World.",
  emptyFolder: "Enter a folder name.",
  folderCharacters: "Folder names can't contain / \\ : * ? \" < > | or control characters.",
  dotFolder: "Choose a folder name other than . or ..",
  dashFolder: "Folder names can't start with a dash (-).",
  folderEnding: "Folder names can't end with a dot or a space.",
  longFolder: "Folder names must be 255 characters or fewer.",
  parentChanged: 'The destination folder changed in another window. Check "Clone to" and try again.',
  badRun: "Vector couldn't start this clone. Close the dialog and try again.",
  canceled: "Clone canceled.",
  network: "Couldn't reach GitHub. Check your internet connection or proxy settings, then try again.",
  certificate:
    "Git couldn't verify GitHub's security certificate. If your network uses a proxy that inspects HTTPS, configure Git to trust its certificate (http.sslCAInfo), then try again.",
  stalled: "The connection to GitHub stalled or dropped during the clone. Check your connection, then try again.",
  sshKey:
    "Your Git settings send GitHub clones over SSH, and GitHub rejected your SSH key. Check your SSH key setup, then try again.",
}

class CloneFailure extends Error {
  constructor(
    readonly kind: GithubCloneErrorKind,
    message: string,
    readonly extra: { detail?: string; suggestedFolder?: string } = {},
  ) {
    super(message)
  }
}

function fail(kind: GithubCloneErrorKind, message: string, extra?: CloneFailure["extra"]): never {
  throw new CloneFailure(kind, message, extra)
}

type CloneRun = {
  sender: number
  label: string
  target?: string
  created: boolean
  canceled: boolean
  child?: ChildProcessWithoutNullStreams
}

type CloneContext = { signedIn: boolean; repo: string; owner: string; parent: string; target: string; folder: string }

const runs = new Map<string, CloneRun>()
let exitHookInstalled = false

export async function cloneGithubRepository(
  input: GithubCloneInput,
  deps: GithubCloneDeps,
): Promise<GithubCloneResult> {
  const runId = typeof input?.runId === "string" && RUN_ID.test(input.runId) ? input.runId : undefined
  if (!runId || runs.has(runId)) return { ok: false, kind: "invalid", error: MESSAGES.badRun }
  const run: CloneRun = { sender: deps.sender, label: "repository", created: false, canceled: false }
  runs.set(runId, run)
  installExitHook()
  const result = await performClone(runId, run, input, deps).catch((error: unknown) => failedClone(run, error))
  runs.delete(runId)
  deps.log?.(
    `github clone ${run.label} -> ${run.target ?? "(no destination)"}: ${result.ok ? (result.reused ? "reused" : "ok") : result.kind}`,
  )
  return result
}

// Only the window that started a run can cancel it. A run that has not spawned git yet is stopped right before spawn.
export function cancelGithubClone(sender: number, runId: unknown) {
  const run = typeof runId === "string" ? runs.get(runId) : undefined
  if (!run || run.sender !== sender) return
  run.canceled = true
  if (run.child) stopAgentProcess(run.child, 3_000)
}

async function performClone(
  runId: string,
  run: CloneRun,
  input: GithubCloneInput,
  deps: GithubCloneDeps,
): Promise<GithubCloneResult> {
  const repo = requireRepository(input.repo)
  run.label = `${repo.owner}/${repo.name}`
  const folder = requireFolder(input.folder)
  const parent = await requireParent(input.parent, deps.parent ?? githubCloneParent)
  const target = claimTargetName(run, parent, folder)
  deps.emit({ runId, phase: "starting", percent: 0, message: "Connecting to GitHub…" })

  const environment = deps.environment ?? process.env
  const git = await requireGit(deps.git, environment)
  const token = await (deps.token ?? getGithubToken)()
  const lookup = await (deps.lookup ?? lookupGithubRepository)(repo, token)
  if (!lookup.ok) fail(lookup.kind, lookup.error)
  const fullName = `${lookup.repo.owner}/${lookup.repo.name}`
  const context = { signedIn: Boolean(token), repo: fullName, owner: lookup.repo.owner, parent, target, folder }

  const names = new Set([run.label.toLowerCase(), fullName.toLowerCase()])
  if ((await claimTarget(run, git, environment, names, context)) === "reused") {
    return { ok: true, directory: target, reused: true, fullName }
  }
  if (run.canceled) fail("canceled", MESSAGES.canceled)

  // Least privilege: a repository GitHub reports as public clones without the token.
  const result = await runClone(runId, run, git, {
    url: `https://github.com/${fullName}.git`,
    target,
    cwd: parent,
    env: gitCloneEnvironment(environment, lookup.private === false ? undefined : token),
    emit: deps.emit,
  })
  if (run.canceled) fail("canceled", MESSAGES.canceled)
  if (result.code !== 0) {
    const failure = classifyCloneFailure(result.output, context)
    fail(failure.kind, failure.error, { detail: failure.detail })
  }
  return { ok: true, directory: target, reused: false, fullName }
}

// Removes only the folder this run created, after git has exited, so a failed or canceled clone leaves nothing behind
// and nothing that existed before is touched.
async function failedClone(run: CloneRun, error: unknown): Promise<GithubCloneResult> {
  const failure = run.canceled
    ? new CloneFailure("canceled", MESSAGES.canceled)
    : error instanceof CloneFailure
      ? error
      : new CloneFailure("failed", `Git couldn't clone ${run.label}. Open "Git output" below for details.`, {
          detail: redactText(error instanceof Error ? error.message : String(error)),
        })
  const target = run.target
  const removed =
    run.created && target
      ? await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).then(
          () => true,
          () => false,
        )
      : true
  return {
    ok: false,
    kind: failure.kind,
    error: removed
      ? failure.message
      : `${failure.message} Vector couldn't remove the partial folder ${target}. Delete it before cloning there again.`,
    ...failure.extra,
  }
}

function requireRepository(input: unknown) {
  const parsed = parseGithubCloneSource(typeof input === "string" ? input : "")
  if (!parsed.ok) fail("invalid", parsed.error)
  return parsed.repo
}

function requireFolder(input: unknown) {
  const parsed = parseCloneFolder(typeof input === "string" ? input : "")
  if (!parsed.ok) fail("invalid", parsed.error)
  return parsed.folder
}

async function requireParent(echoed: unknown, current: () => Promise<GithubCloneParent>) {
  const parent = await current()
  if (echoed !== parent.path) fail("invalid", MESSAGES.parentChanged)
  const unusable = () => fail("disk", `Vector can't use ${parent.path} as the destination. Choose another folder.`)
  // Only the fixed OS default is ever created, and only when the user clones into it.
  if (parent.isDefault) await mkdir(parent.path, { recursive: true }).catch(unusable)
  const real = await realpath(parent.path).catch(unusable)
  if (!(await stat(real).catch(() => undefined))?.isDirectory()) unusable()
  return real
}

function claimTargetName(run: CloneRun, parent: string, folder: string) {
  const target = join(parent, folder)
  if (dirname(target) !== parent) fail("invalid", MESSAGES.folderCharacters)
  const key = targetKey(target)
  if ([...runs.values()].some((other) => other !== run && other.target && targetKey(other.target) === key)) {
    fail("busy", `Vector is already cloning into ${target}. Wait for it to finish or cancel it first.`)
  }
  run.target = target
  return target
}

function targetKey(target: string) {
  return process.platform === "win32" || process.platform === "darwin" ? target.toLowerCase() : target
}

// A missing folder is claimed with a non-recursive mkdir, which is atomic. An existing folder is reused only when it is
// a finished clone of this repository. Symlinks are never followed.
async function claimTarget(
  run: CloneRun,
  git: string,
  environment: AgentEnvironment,
  names: Set<string>,
  context: CloneContext,
) {
  const exists = await lstat(context.target).then(
    () => true,
    (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? false : fsFailure(error, context)),
  )
  const created =
    !exists &&
    (await mkdir(context.target).then(
      () => true,
      (error: NodeJS.ErrnoException) => (error.code === "EEXIST" ? false : fsFailure(error, context)),
    ))
  if (created) {
    run.created = true
    return "created" as const
  }

  const stats = await lstat(context.target)
  const env = gitCloneEnvironment(environment)
  // --file reads only that file (no includes, no repository discovery) and --git-dir skips discovery, so neither runs
  // into safe.directory or a parent repository.
  const origin = stats.isDirectory()
    ? await runGit(git, ["config", "--file", join(context.target, ".git", "config"), "--get", "remote.origin.url"], env)
    : undefined
  const remote = origin?.ok ? parseGithubRemote(origin.stdout) : undefined
  if (!remote || !names.has(`${remote.owner}/${remote.name}`.toLowerCase())) {
    fail(
      "exists",
      `"${context.folder}" already exists in ${context.parent} and isn't a clone of ${context.repo}. Choose another folder name or location.`,
      { suggestedFolder: await suggestFolder(context) },
    )
  }
  const head = await runGit(
    git,
    ["--git-dir", join(context.target, ".git"), "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    env,
  )
  if (!head.ok) {
    fail(
      "exists",
      `"${context.folder}" in ${context.parent} has an unfinished clone of ${context.repo}. Delete that folder or choose another folder name.`,
      { suggestedFolder: await suggestFolder(context) },
    )
  }
  return "reused" as const
}

async function suggestFolder(context: CloneContext) {
  const candidates = Array.from({ length: 19 }, (_, index) => `${context.folder}-${index + 2}`)
  const free = await Promise.all(
    candidates.map((name) =>
      lstat(join(context.parent, name)).then(
        () => false,
        () => true,
      ),
    ),
  )
  return candidates.find((_, index) => free[index])
}

function fsFailure(error: NodeJS.ErrnoException, context: CloneContext): never {
  if (error.code === "ENOSPC" || error.code === "EDQUOT") {
    fail("disk", `There isn't enough free disk space in ${context.parent}. Free up space or choose another location.`)
  }
  if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
    fail("disk", `Vector can't write to ${context.parent}. Choose a folder you have permission to write to.`)
  }
  fail("disk", `Vector can't use ${context.parent} as the destination. Choose another folder.`)
}

// ---- Finding git -----------------------------------------------------------------------------------------------

async function requireGit(explicit: string | undefined, environment: AgentEnvironment) {
  // process.env already carries the login shell's PATH (preferAppEnv), and resolveAgentPath also looks where Git for
  // Windows, Homebrew and the system install it, which finds a git installed after launch without re-probing the shell.
  const git = explicit ?? (await resolveAgentPath("git", environment))
  // Git for Windows ships git.exe; a .cmd or .bat named git would have to run through cmd.exe, which Vector never does.
  if (!git || (process.platform === "win32" && !git.toLowerCase().endsWith(".exe"))) {
    fail("git-missing", gitInstallHint(process.platform))
  }
  const version = await runGit(git, ["--version"], gitCloneEnvironment(environment))
  if (version.missing || XCRUN.test(version.stderr)) fail("git-missing", gitInstallHint(process.platform))
  const match = /git version ((\d+)\.(\d+)(?:\.\d+)?)/.exec(version.stdout)
  if (!match) {
    fail("failed", `Git couldn't clone this repository. Open "Git output" below for details.`, {
      detail: redactText(`${version.stdout}\n${version.stderr}`.trim()),
    })
  }
  const major = Number(match[2])
  const minor = Number(match[3])
  // GIT_CONFIG_COUNT, which carries the transient auth header, arrived in Git 2.31.
  if (major < 2 || (major === 2 && minor < 31)) {
    fail(
      "git-outdated",
      `Vector needs Git 2.31 or newer to clone. This computer has Git ${match[1]}. Update Git, then try again.`,
    )
  }
  return git
}

export function gitInstallHint(platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return "Git isn't installed on this Mac. Run xcode-select --install in Terminal to install Apple's Command Line Tools (or install Git with Homebrew: brew install git), then try again."
  }
  if (platform === "win32") {
    return "Git isn't installed. Install Git for Windows from https://git-scm.com/download/win, or run winget install --id Git.Git -e in a terminal, then try again."
  }
  return "Git isn't installed. Install it with your package manager, for example sudo apt install git or sudo dnf install git, then try again."
}

type GitOutput = { ok: boolean; missing: boolean; stdout: string; stderr: string }

function runGit(git: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<GitOutput>((resolve) => {
    execFile(git, args, { env, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      }),
    )
  })
}

// ---- Running the clone ------------------------------------------------------------------------------------------

type CloneCommand = {
  url: string
  target: string
  cwd: string
  env: NodeJS.ProcessEnv
  emit: (progress: GithubCloneProgress) => void
}

function runClone(runId: string, run: CloneRun, git: string, command: CloneCommand) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    // No --recurse-submodules: submodules can point at any host, and the token header is scoped to github.com anyway.
    // POSIX children get their own process group so a cancel also stops git-remote-https and index-pack.
    const child = spawn(git, ["clone", "--progress", "--", command.url, command.target], {
      cwd: command.cwd,
      detached: process.platform !== "win32",
      env: command.env,
      stdio: "pipe",
      windowsHide: true,
    })
    run.child = child
    child.stdin.end()
    child.stdout.resume()
    const decoder = new StringDecoder("utf8")
    const last = { phase: "starting" as GithubClonePhase, percent: 0 }
    let buffer = ""
    let output = ""
    const consume = (raw: string) => {
      const line = raw.trim()
      if (!line) return
      const progress = parseCloneProgress(line)
      if (!progress) {
        // The tail feeds error mapping and the "Git output" details; 8 KB holds every fatal: line git prints.
        output = `${output}${line}\n`.slice(-8192)
        return
      }
      if (progress.phase === last.phase && progress.percent <= last.percent) return
      last.phase = progress.phase
      last.percent = Math.max(last.percent, progress.percent)
      command.emit({ runId, phase: last.phase, percent: last.percent, message: redactText(line).slice(0, 200) })
    }
    // git redraws progress in place with \r, so both \r and \n end a line.
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = `${buffer}${decoder.write(chunk)}`.split(/[\r\n]/)
      buffer = lines.pop() ?? ""
      lines.forEach(consume)
    })
    // A started git can also report a failed kill here; only a git that never started ends the run, and "close"
    // settles every other case once the process tree is gone.
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return
      run.child = undefined
      reject(error.code === "ENOENT" ? new CloneFailure("git-missing", gitInstallHint(process.platform)) : error)
    })
    child.once("close", (code) => {
      run.child = undefined
      consume(`${buffer}${decoder.end()}`)
      resolve({ code, output })
    })
  })
}

// Quitting mid-clone stops git and removes the folder this run created. On Windows a locked file can leave it behind;
// the HEAD check then reports it as an unfinished clone instead of opening a broken repository.
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", () => {
    for (const run of runs.values()) {
      if (run.child) signalAgentProcess(run.child, "SIGKILL")
      if (!run.created || !run.target) continue
      try {
        rmSync(run.target, { recursive: true, force: true })
      } catch {
        // An exit handler must not throw.
      }
    }
  })
}

// ---- Auth, environment and progress ----------------------------------------------------------------------------

// The token rides only in this child's environment, as GIT_CONFIG_COUNT/KEY/VALUE entries. Git applies them to this
// one command and never writes them to .git/config, so the remote stays the plain https URL and later pushes use the
// user's own credentials (or Vector's push, which adds the header again for that push only).
export function gitCloneEnvironment(base: NodeJS.ProcessEnv, token?: string) {
  const config = [
    // git runs an askpass helper before it checks GIT_TERMINAL_PROMPT, so none may be configured.
    ["core.askPass", ""],
    // Resets any header configured for github.com, so only Vector's (or none) is sent.
    ["http.https://github.com/.extraheader", ""],
    // Stalls fail as "too slow" instead of hanging; there is no overall timeout, because large repositories are slow.
    ["http.lowSpeedLimit", "1000"],
    ["http.lowSpeedTime", "60"],
    ...(token
      ? [
          // With the token, no credential helper is asked or told anything, and the header never follows a redirect.
          ["credential.helper", ""],
          ["http.followRedirects", "false"],
          ["http.https://github.com/.extraheader", buildOauthPushHeader(token)],
        ]
      : []),
  ]
  return {
    ...Object.fromEntries(
      Object.entries(untrustedChildEnvironment(base)).filter(
        ([key]) => !/^(GIT_|SSH_ASKPASS$)/i.test(key) || KEEP.has(key.toUpperCase()),
      ),
    ),
    GIT_TERMINAL_PROMPT: "0",
    // Git Credential Manager would otherwise open a sign-in window; saved credentials still work.
    GCM_INTERACTIVE: "never",
    // English messages, so the failure patterns below match.
    LC_ALL: "C",
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(
      config.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${index}`, key],
        [`GIT_CONFIG_VALUE_${index}`, value],
      ]),
    ),
  }
}

export function parseCloneProgress(line: string) {
  const match = PROGRESS.exec(line)
  if (!match) return
  const range = PHASES[match[1] as keyof typeof PHASES]
  const percent = Math.min(100, Number(match[2]))
  return {
    phase: range[0] as GithubClonePhase,
    percent: Math.round(range[1] + ((range[2] - range[1]) * percent) / 100),
  }
}

// Patterns run in order against git's English stderr (LC_ALL=C). Messages never quote the raw output; the redacted
// last fatal:/error: line goes into `detail` for the dialog's "Git output" disclosure.
export function classifyCloneFailure(
  output: string,
  context: Pick<CloneContext, "signedIn" | "repo" | "owner" | "parent">,
): { kind: GithubCloneErrorKind; error: string; detail?: string } {
  const text = output.toLowerCase()
  const rules: Array<[RegExp, GithubCloneErrorKind, string]> = [
    [XCRUN, "git-missing", gitInstallHint("darwin")],
    [
      /saml/,
      "auth",
      `${context.owner} requires single sign-on. On github.com, go to Settings > Applications > Authorized OAuth Apps > Vector, grant access to ${context.owner}, then try again.`,
    ],
    [/permission denied \(publickey\)|host key verification failed/, "auth", MESSAGES.sshKey],
    ...(context.signedIn
      ? [
          [
            /returned error: 403/,
            "auth",
            `GitHub refused access to ${context.repo} with your sign-in. If it belongs to an organization that uses single sign-on, authorize Vector for that organization on github.com, then try again.`,
          ] as [RegExp, GithubCloneErrorKind, string],
        ]
      : []),
    [
      /repository not found|repository '[^']*' not found|authentication failed|could not read username|terminal prompts disabled|invalid username or password|returned error: 401/,
      context.signedIn ? "not-found" : "auth",
      context.signedIn
        ? `GitHub couldn't find ${context.repo}, or your GitHub account doesn't have access to it. Check the name or ask the owner for access.`
        : `GitHub couldn't find ${context.repo}. If it's a private repository, connect GitHub and try again.`,
    ],
    [/ssl certificate problem|certificate verify|unable to get local issuer/, "network", MESSAGES.certificate],
    [/operation too slow|rpc failed|early eof|remote end hung up|transfer closed/, "network", MESSAGES.stalled],
    [
      /could not resolve host|failed to connect|couldn't connect|connection timed out|timed out|connect tunnel failed|unable to access/,
      "network",
      MESSAGES.network,
    ],
    [
      /no space left|disk quota/,
      "disk",
      `There isn't enough free disk space in ${context.parent}. Free up space or choose another location.`,
    ],
    [
      /filename too long/,
      "disk",
      `Some paths in ${context.repo} are too long for Windows. Choose a shorter destination such as C:\\src, or run git config --global core.longpaths true, then try again.`,
    ],
    [
      /permission denied|access is denied|read-only file system|could not create work tree|unable to create/,
      "disk",
      `Vector can't write to ${context.parent}. Choose a folder you have permission to write to.`,
    ],
  ]
  const rule = rules.find(([pattern]) => pattern.test(text))
  const detail = failureDetail(output)
  if (rule) return { kind: rule[1], error: rule[2], detail }
  return { kind: "failed", error: `Git couldn't clone ${context.repo}. Open "Git output" below for details.`, detail }
}

function failureDetail(output: string) {
  const lines = output
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines.findLast((entry) => /^(fatal|error):/i.test(entry)) ?? lines.at(-1)
  return line ? redactText(line).slice(0, 2000) : undefined
}

// ---- Repository source -----------------------------------------------------------------------------------------

// Accepts owner/name, github.com links (https, http, www., bare host, browser paths such as /tree/main), and
// git@github.com:owner/name. The clone URL is always rebuilt from the validated owner and name, and error messages
// never repeat the input, because a pasted link might carry a token.
export function parseGithubCloneSource(input: string): GithubCloneParse {
  const text = input.trim()
  if (!text) return { ok: false, error: MESSAGES.emptySource }
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i.exec(text)
  if (scp) return repository(scp[1], scp[2])
  if (!text.includes("/")) return { ok: false, error: MESSAGES.invalidRepo }
  // An owner never contains a dot, so "github.com/owner" or "gitlab.com/owner" is a link, not owner/name.
  const bare = /^([^/:@\s.]+)\/([^/:@\s]+)$/.exec(text)
  if (bare) return repository(bare[1], bare[2])
  return repositoryFromUrl(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
}

function repositoryFromUrl(raw: string): GithubCloneParse {
  if (!URL.canParse(raw)) return { ok: false, error: MESSAGES.otherHost }
  const url = new URL(raw)
  if (!["https:", "http:", "ssh:"].includes(url.protocol)) return { ok: false, error: MESSAGES.otherHost }
  const credentials = url.protocol === "ssh:" ? url.username !== "git" || url.password : url.username || url.password
  if (credentials) return { ok: false, error: MESSAGES.credentials }
  if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase()) || url.port) {
    return { ok: false, error: MESSAGES.otherHost }
  }
  const segments = url.pathname.split("/").filter(Boolean)
  if (segments.length < 2 || (url.protocol === "ssh:" && segments.length !== 2)) {
    return { ok: false, error: MESSAGES.invalidRepo }
  }
  return repository(segments[0], segments[1])
}

function repository(owner: string, rawName: string): GithubCloneParse {
  const name = rawName.replace(/\.git$/i, "")
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    return { ok: false, error: MESSAGES.invalidRepo }
  }
  return { ok: true, repo: { owner, name } }
}

// The same rules on every OS, so a clone made on one machine can be copied to another.
export function parseCloneFolder(input: string): { ok: true; folder: string } | { ok: false; error: string } {
  if (!input.trim()) return { ok: false, error: MESSAGES.emptyFolder }
  if (input.length > 255) return { ok: false, error: MESSAGES.longFolder }
  if (/[<>:"/\\|?*\x00-\x1f]/.test(input)) return { ok: false, error: MESSAGES.folderCharacters }
  if (input === "." || input === "..") return { ok: false, error: MESSAGES.dotFolder }
  if (input.startsWith("-")) return { ok: false, error: MESSAGES.dashFolder }
  if (/[. ]$/.test(input)) return { ok: false, error: MESSAGES.folderEnding }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(input)) {
    return { ok: false, error: `"${input}" is a reserved name on Windows. Choose another folder name.` }
  }
  return { ok: true, folder: input }
}

// ---- Repository lookup -----------------------------------------------------------------------------------------

// Optional: GitHub's answer gives the canonical name after a rename and whether the repository is public. Any answer
// other than a clear "no access" lets git decide, so public repositories clone even when the API is unreachable.
export async function lookupGithubRepository(repo: GithubCloneRepo, token?: string): Promise<GithubRepositoryLookup> {
  const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}`, {
    headers: token
      ? apiHeaders(token)
      : { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const body: unknown = res ? await res.json().catch(() => undefined) : undefined
  const result = repositoryLookupResult(repo, Boolean(token), res?.status, body)
  if (!result.ok && result.expired) logoutGithub()
  return result
}

export function repositoryLookupResult(
  repo: GithubCloneRepo,
  signedIn: boolean,
  status: number | undefined,
  body: unknown,
): GithubRepositoryLookup {
  const data = (body && typeof body === "object" ? body : {}) as {
    full_name?: unknown
    private?: unknown
    message?: unknown
  }
  const message = typeof data.message === "string" ? data.message : ""
  const name = `${repo.owner}/${repo.name}`
  if (status === 200) {
    const canonical = typeof data.full_name === "string" ? parseGithubCloneSource(data.full_name) : undefined
    return {
      ok: true,
      repo: canonical?.ok ? canonical.repo : repo,
      private: typeof data.private === "boolean" ? data.private : undefined,
    }
  }
  if (status === 401 && signedIn) {
    return {
      ok: false,
      kind: "auth",
      expired: true,
      error: `Your GitHub sign-in has expired. Connect GitHub again to clone ${name}.`,
    }
  }
  if (status === 404 && signedIn) {
    return {
      ok: false,
      kind: "not-found",
      error: `GitHub couldn't find ${name}, or your GitHub account doesn't have access to it. Check the name or ask the owner for access.`,
    }
  }
  if (status === 403 && /SAML/i.test(message)) {
    return {
      ok: false,
      kind: "auth",
      error: `${repo.owner} requires single sign-on. On github.com, go to Settings > Applications > Authorized OAuth Apps > Vector, grant access to ${repo.owner}, then try again.`,
    }
  }
  if (status === 403 && /OAuth App access restrictions/i.test(message)) {
    return {
      ok: false,
      kind: "auth",
      error: `${repo.owner} blocks apps its owners haven't approved. Ask an owner of ${repo.owner} to approve Vector (or request it from Settings > Applications > Authorized OAuth Apps > Vector on github.com), then try again.`,
    }
  }
  return { ok: true, repo }
}

// ---- Destination parent ----------------------------------------------------------------------------------------

// Apple's ~/Developer and Visual Studio's source\repos stay out of iCloud- and OneDrive-synced Documents folders.
export function defaultCloneParent(platform: NodeJS.Platform, home: string) {
  if (platform === "darwin") return posix.join(home, "Developer")
  if (platform === "win32") return win32.join(home, "source", "repos")
  return posix.join(home, "Projects")
}

export async function githubCloneParent(): Promise<GithubCloneParent> {
  return cloneParentFrom(
    getStore().get(GITHUB_CLONE_PARENT_KEY),
    defaultCloneParent(process.platform, electron.app.getPath("home")),
  )
}

// The remembered folder wins only while it is still an existing directory.
export async function cloneParentFrom(stored: unknown, fallback: string): Promise<GithubCloneParent> {
  const usable =
    typeof stored === "string" &&
    isAbsolute(stored) &&
    Boolean((await stat(stored).catch(() => undefined))?.isDirectory())
  return usable ? { path: stored, isDefault: false } : { path: fallback, isDefault: true }
}

export async function pickGithubCloneParent(window?: BrowserWindow): Promise<GithubCloneParent | null> {
  const current = await githubCloneParent()
  const options: OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    title: "Choose where to clone repositories",
    buttonLabel: "Choose",
    defaultPath: current.path,
  }
  const result = window
    ? await electron.dialog.showOpenDialog(window, options)
    : await electron.dialog.showOpenDialog(options)
  const picked = result.canceled ? undefined : result.filePaths[0]
  if (!picked) return null
  const path = await realpath(picked)
  if (!(await stat(path)).isDirectory()) return null
  getStore().set(GITHUB_CLONE_PARENT_KEY, path)
  return { path, isDefault: false }
}
