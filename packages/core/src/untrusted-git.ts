export * as UntrustedGit from "./untrusted-git"

import { execFile } from "node:child_process"
import os from "node:os"
import { untrustedChildEnvironment } from "./child-environment"

// Read-only git in a working tree Vector may not trust. A repository's own .git/config can name programs that git runs
// on reads: core.fsmonitor on anything that looks at the index, gpg.*.program when log.showSignature is on, hooks, a
// textconv or external diff driver, and a fetch (ssh, or any transport) when a partial clone lazily fetches an object.
// A -c setting beats the repository's config, so each of these is set to something that runs nothing:
// --no-optional-locks keeps a read from writing the index (and firing post-index-change), and a hook or signature
// program at the null device cannot start. The child also gets an environment without Vector's own secrets.
const ARGS = [
  "--no-pager",
  "--no-optional-locks",
  ...[
    "core.fsmonitor=false",
    "core.useBuiltinFSMonitor=false",
    `core.hooksPath=${os.devNull}`,
    "log.showSignature=false",
    `gpg.program=${os.devNull}`,
    `gpg.openpgp.program=${os.devNull}`,
    `gpg.ssh.program=${os.devNull}`,
    `gpg.x509.program=${os.devNull}`,
    "protocol.allow=never",
    ...["ext", "file", "git", "http", "https", "ssh"].map((name) => `protocol.${name}.allow=never`),
  ].flatMap((setting) => ["-c", setting]),
] as const

// Subcommands that can render a diff, where an external diff or textconv driver would run.
const DIFFS = new Set(["log", "show", "diff", "whatchanged"])

/** The full argument list `run` gives git: the hardening, then the subcommand with its diff drivers off. */
export function args(command: readonly string[]) {
  const [subcommand, ...rest] = command
  if (!subcommand) return [...ARGS]
  return [...ARGS, subcommand, ...(DIFFS.has(subcommand) ? ["--no-ext-diff", "--no-textconv"] : []), ...rest]
}

/** A git command's output, or "" when git is missing, the directory is not a repository, or the command fails. */
export function run(
  cwd: string,
  command: readonly string[],
  options: { readonly timeout?: number; readonly maxBuffer?: number } = {},
) {
  return new Promise<string>((resolve) =>
    execFile(
      "git",
      args(command),
      {
        cwd,
        env: { ...untrustedChildEnvironment(), GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
        timeout: options.timeout ?? 10_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? "" : stdout),
    ),
  )
}
