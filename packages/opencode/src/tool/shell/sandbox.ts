export * as Sandbox from "./sandbox"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Shell } from "@opencode-ai/core/shell"
import { which } from "@opencode-ai/core/util/which"

export type Mechanism = "seatbelt" | "bubblewrap" | "none"

export type Availability = {
  supported: boolean
  mechanism: Mechanism
  reason?: string
}

export type Wrapped = {
  command: string
  args: string[]
  shell: string | false
  env: NodeJS.ProcessEnv
  sandboxed: boolean
  mechanism: Mechanism
  reason?: string
}

const SEATBELT = "/usr/bin/sandbox-exec"

// Home-relative paths worth more than the convenience of reading them. An agent
// that cannot read a key cannot leak one, and nothing in a normal build needs
// these. Anything listed here still resolves for the user's own tools, which run
// outside the sandbox.
const SECRETS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".config/gcloud",
  ".config/google-chrome",
  ".config/chromium",
  ".kube",
  ".docker/config.json",
  ".netrc",
  ".password-store",
  ".gem/credentials",
  ".mozilla",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Safari",
  "Library/Messages",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Firefox",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
]

// Package managers write into a shared per-user cache rather than the workspace,
// so a sandbox that forbids these turns every first build into a failure. This is
// the deliberate soft spot of the policy: a cache directory on PATH (~/.bun/bin,
// ~/.cargo/bin) stays writable, so the sandbox bounds blast radius rather than
// promising containment against an agent that is actively trying to escape.
const CACHES = [
  ".cache",
  ".npm",
  ".bun",
  ".yarn",
  ".pnpm-store",
  ".deno",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".gem",
  ".nuget",
  ".dotnet",
  ".pub-cache",
  ".cocoapods",
  ".node-gyp",
  ".electron",
  ".local/share/pnpm",
  ".local/state",
  "go/pkg/mod",
  "Library/Caches",
  "Library/pnpm",
  "Library/Developer/Xcode/DerivedData",
]

export function sandboxAvailability(platform: NodeJS.Platform = process.platform): Availability {
  if (platform === "darwin") {
    if (fs.existsSync(SEATBELT)) return { supported: true, mechanism: "seatbelt" }
    return { supported: false, mechanism: "none", reason: `${SEATBELT} is missing, so seatbelt cannot be applied` }
  }

  if (platform === "linux") {
    if (which("bwrap")) return { supported: true, mechanism: "bubblewrap" }
    return {
      supported: false,
      mechanism: "none",
      reason: "bubblewrap (bwrap) is not on PATH, so no sandbox can be applied",
    }
  }

  if (platform === "win32") {
    return {
      supported: false,
      mechanism: "none",
      reason: "Windows ships no equivalent to seatbelt or bubblewrap, so commands run unsandboxed",
    }
  }

  return { supported: false, mechanism: "none", reason: `no sandbox mechanism is implemented for ${platform}` }
}

/**
 * Renders a seatbelt (SBPL) profile. Pure: every path it needs is passed in, so
 * tests can assert the exact policy text without spawning anything.
 *
 * Rule order is load-bearing. SBPL is last-match-wins, so the broad
 * `(allow file-read*)` has to come before the secret denials or the denials are
 * silently overridden.
 */
export function seatbeltProfile(input: {
  writable: readonly string[]
  denyRead: readonly string[]
  allowNetwork: boolean
}) {
  const writable = Array.from(new Set(input.writable)).filter(Boolean)
  const denyRead = Array.from(new Set(input.denyRead)).filter(Boolean)

  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    // Only processes inside this same sandbox: a build may manage its own
    // children, but it has no business signalling the editor that spawned it.
    "(allow signal (target same-sandbox))",
    "(allow file-read*)",
    // An empty filter list is a profile the kernel rejects, so a caller with no
    // writable roots gets a read-only sandbox rather than a broken one.
    ...(writable.length > 0
      ? ["(allow file-write*", ...writable.map((file) => `  (subpath ${literal(file)})`), ")"]
      : []),
    // Terminals, /dev/null and process substitution via /dev/fd. Without these a
    // plain `cmd > /dev/null` fails under (deny default).
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/full")',
    '  (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/tty")',
    '  (literal "/dev/stdin") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (literal "/dev/ptmx") (subpath "/dev/fd") (regex #"^/dev/tty[a-z0-9]*$"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/ptmx")',
    '  (regex #"^/dev/tty[a-z0-9]*$"))',
    "(allow pseudo-tty)",
    // A secret can sit inside a writable cache root (~/.gem/credentials lives in
    // the writable ~/.gem), and the earlier (allow file-write*) would otherwise
    // let an agent clobber a credential it is not allowed to read. Denying the
    // write here overrides that grant without revoking the parent cache.
    ...(denyRead.length > 0
      ? ["(deny file-write*", ...denyRead.map((file) => `  (subpath ${literal(file)})`), ")"]
      : []),
    ...(denyRead.length > 0 ? ["(deny file-read*", ...denyRead.map((file) => `  (subpath ${literal(file)})`), ")"] : []),
    // Registries and package downloads are the common case, so network stays on
    // unless the caller turns it off. Unix sockets survive either way because
    // local toolchains (compiler daemons, DNS) talk over them.
    ...(input.allowNetwork ? ["(allow network*)"] : ["(deny network*)", "(allow network* (local unix) (remote unix))"]),
    "",
  ].join("\n")
}

export function wrapCommand(input: {
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  allowNetwork?: boolean
  workspaceRoot: string
  platform?: NodeJS.Platform
}): Wrapped {
  const platform = input.platform ?? process.platform

  // Preserved verbatim from the pre-sandbox shell tool: PowerShell needs an
  // explicit argv rather than a `shell:` option, and Windows has nothing to wrap
  // it in.
  if (platform === "win32") {
    const availability = sandboxAvailability(platform)
    if (Shell.ps(input.shell)) {
      return {
        command: input.shell,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command],
        shell: false,
        env: input.env,
        sandboxed: false,
        mechanism: "none",
        reason: availability.reason,
      }
    }
    return {
      command: input.command,
      args: [],
      shell: input.shell,
      env: input.env,
      sandboxed: false,
      mechanism: "none",
      reason: availability.reason,
    }
  }

  const unwrapped = (reason?: string): Wrapped => ({
    command: input.command,
    args: [],
    shell: input.shell,
    env: input.env,
    sandboxed: false,
    mechanism: "none",
    reason,
  })

  const availability = sandboxAvailability(platform)
  if (!availability.supported) return unwrapped(availability.reason)

  // The degradation contract: a path that cannot be resolved costs the user a
  // sandbox, never their shell tool. Note the limit — this only covers building
  // the profile. If the kernel rejects the profile it does so inside the spawned
  // sandbox-exec, where nothing here can catch it, and the command fails.
  try {
    const allowNetwork = input.allowNetwork ?? true
    const home = canonical(os.homedir())
    // cwd is writable on purpose. A workdir outside the project has already been
    // approved through the external_directory permission, and silently failing
    // writes there would contradict a prompt the user just answered.
    // A non-git project reports "/" as its worktree. Granting write to that root
    // would make the profile decorative, so it is dropped and the working
    // directory below carries the project's own writes instead.
    const writable = [
      canonical(input.workspaceRoot),
      canonical(input.cwd),
      canonical(os.tmpdir()),
      ...CACHES.map((entry) => canonical(path.join(home, entry))),
    ].filter((file) => file !== "/")
    const denyRead = SECRETS.map((entry) => canonical(path.join(home, entry)))

    if (availability.mechanism === "seatbelt") {
      return {
        command: SEATBELT,
        args: [
          "-p",
          seatbeltProfile({
            writable: [...writable, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"],
            denyRead: [...denyRead, "/Library/Keychains"],
            allowNetwork,
          }),
          input.shell,
          "-c",
          input.command,
        ],
        shell: false,
        env: input.env,
        sandboxed: true,
        mechanism: "seatbelt",
      }
    }

    const bwrap = which("bwrap")
    if (!bwrap) return unwrapped("bubblewrap (bwrap) disappeared from PATH before the command could be wrapped")

    return {
      command: bwrap,
      args: [
        "--die-with-parent",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-pid",
        ...(allowNetwork ? [] : ["--unshare-net"]),
        // Order matters: each later mount lands on top of the read-only root.
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        ...writable.filter(fs.existsSync).flatMap((file) => ["--bind", file, file]),
        // bwrap has no read filter, so covering the path is how a secret gets
        // hidden. A tmpfs only mounts over a directory, so a secret that is a
        // plain file (.netrc, .docker/config.json) gets /dev/null bound over it
        // instead: mounting a tmpfs there fails and takes the whole run with it.
        ...denyRead
          .filter(fs.existsSync)
          .flatMap((file) => (fs.statSync(file).isDirectory() ? ["--tmpfs", file] : ["--ro-bind", "/dev/null", file])),
        "--chdir",
        input.cwd,
        input.shell,
        "-c",
        input.command,
      ],
      shell: false,
      env: input.env,
      sandboxed: true,
      mechanism: "bubblewrap",
    }
  } catch (error) {
    return unwrapped(`sandbox profile could not be built (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Seatbelt matches on the path the kernel resolves to, so an unresolved symlink
 * matches nothing at all: `(subpath "/tmp/x")` grants no write to /tmp/x on macOS
 * because /tmp is a link to /private/tmp. Paths that do not exist yet are kept
 * as-is so a package manager can still create its own cache directory.
 */
function canonical(file: string) {
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) return resolved
  // Several of the paths we deny are exactly the ones macOS protects with TCC,
  // and realpath's lstat on them raises EPERM. Falling back to the literal path
  // keeps the rule (these are real directories, not symlinks) instead of losing
  // the whole profile over a directory we were never allowed to inspect.
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function literal(file: string) {
  return `"${file.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
