import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { UntrustedGit } from "@vectordevai/core/untrusted-git"
import { tmpdir, tmpdirIn } from "../fixture/tmpdir"
import { withKnowledge } from "./fixture/knowledge"

// A repository that arrives with its own .git (an archive, a shared folder) can name programs in .git/config that git
// runs on reads. The brain reads such repositories on its own after every run, held or not, so none of them may run.

const SECRET = "placeholder-not-a-real-key"

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" })

// A commit that carries a signature, which `git log` hands to gpg.program when log.showSignature is on.
function signedCommit(root: string) {
  git(root, "add", "-A")
  const tree = git(root, "write-tree").trim()
  const object = [
    `tree ${tree}`,
    "author Test <test@example.com> 1700000000 +0000",
    "committer Test <test@example.com> 1700000000 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " iQEzBAABCAAdFiEEplaceholder",
    " -----END PGP SIGNATURE-----",
    "",
    "Add the service",
    "",
  ].join("\n")
  const commit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: root, input: object, encoding: "utf8" }).trim()
  git(root, "update-ref", "HEAD", commit)
}

// The repository's config names one program for every hook it can: it notes that it ran, and what it was given.
async function plant(root: string) {
  const hook = path.join(path.dirname(root), "hook.sh")
  const ran = path.join(path.dirname(root), "ran.txt")
  await fs.writeFile(hook, `#!/bin/sh\necho "ran key=$VECTOR_CREDENTIAL_KEY" >> "${ran}"\nexit 0\n`, { mode: 0o755 })
  const hooks = path.join(path.dirname(root), "hooks")
  await fs.mkdir(hooks, { recursive: true })
  for (const name of ["post-index-change", "post-checkout", "reference-transaction"])
    await fs.copyFile(hook, path.join(hooks, name)).then(() => fs.chmod(path.join(hooks, name), 0o755))
  git(root, "config", "core.fsmonitor", hook)
  git(root, "config", "log.showSignature", "true")
  git(root, "config", "gpg.program", hook)
  git(root, "config", "core.hooksPath", hooks)
  return { ran: () => fs.readFile(ran, "utf8").catch(() => ""), reset: () => fs.rm(ran, { force: true }) }
}

const previous = process.env.VECTOR_CREDENTIAL_KEY
beforeEach(() => {
  process.env.VECTOR_CREDENTIAL_KEY = SECRET
})
afterEach(() => {
  if (previous === undefined) delete process.env.VECTOR_CREDENTIAL_KEY
  else process.env.VECTOR_CREDENTIAL_KEY = previous
})

describe.skipIf(process.platform === "win32")("the brain's git calls", () => {
  test("never run a program a held repository's own git config names", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          signedCommit(setup.root)
          const planted = yield* Effect.promise(() => plant(setup.root))
          // Plain git runs the planted program and hands it the secret, so the repository is set up to.
          execFileSync("git", ["ls-files"], { cwd: setup.root, env: { ...process.env } })
          execFileSync("git", ["log", "--format=%H", "--name-only", "-n", "1"], { cwd: setup.root, env: { ...process.env } })
          const control = yield* Effect.promise(planted.ran)
          yield* Effect.promise(planted.reset)
          yield* setup.knowledge.add(setup.place, {
            type: "text",
            name: "auth.md",
            text: "# Auth\n\nThe `refreshTokenTtl` MUST be 14 days.",
            origin: "upload",
          })
          const scanned = yield* setup.knowledge.scan(setup.place, { force: true })
          const indexed = yield* setup.knowledge.code(setup.place)
          yield* setup.knowledge.drift(setup.place, { force: true })
          yield* setup.knowledge.link(setup.place)
          return { control, scanned, indexed, ran: yield* Effect.promise(planted.ran) }
        }),
      {
        git: true,
        held: true,
        files: {
          "README.md": "# Service\n\nThe service MUST round money to integer cents.",
          "src/auth/session.ts": "export const refreshTokenTtl = 14 * 24 * 60 * 60\n",
        },
      },
    )
    expect(result.control).toContain(`ran key=${SECRET}`)
    // The brain still read the repository: its docs and its code.
    expect(result.scanned).toBe(1)
    expect(result.indexed.files).toBeGreaterThan(0)
    expect(result.ran).toBe("")
  })
})

describe("UntrustedGit.program", () => {
  // Windows looks for a bare program name in the child's working directory before PATH, which for the brain is a
  // repository it may not trust. On Windows, git comes from an absolute PATH entry only.
  test("on Windows, takes git from an absolute PATH entry, never from a repository or a relative entry", async () => {
    await using tmp = await tmpdir()
    // The planted repository sits under the working directory, so its PATH entry stays relative and still reaches the
    // planted git. On Windows CI the temporary folder is on another drive, where path.relative returns an absolute path.
    await using repo = await tmpdirIn(process.cwd())
    const bin = path.join(tmp.path, "Git", "cmd")
    await fs.mkdir(bin, { recursive: true })
    await fs.writeFile(path.join(repo.path, "git.exe"), "planted")
    await fs.writeFile(path.join(bin, "git.exe"), "installed")
    const relative = path.relative(process.cwd(), repo.path)
    expect(path.isAbsolute(relative)).toBe(false)
    const PATH = (...dirs: string[]) => ({ PATH: dirs.join(path.delimiter) })
    expect(UntrustedGit.program("win32", PATH(".", "", relative, `"${bin}"`))).toBe(path.join(bin, "git.exe"))
    expect(UntrustedGit.program("win32", PATH(".", relative))).toBeUndefined()
    expect(UntrustedGit.program("win32", {})).toBeUndefined()
    // A folder named git.exe is not a program.
    await fs.mkdir(path.join(tmp.path, "odd", "git.exe"), { recursive: true })
    expect(UntrustedGit.program("win32", PATH(path.join(tmp.path, "odd"), bin))).toBe(path.join(bin, "git.exe"))
    expect(UntrustedGit.program("darwin", PATH("."))).toBe("git")
  })

  test.skipIf(process.platform !== "win32")("on Windows, a git.exe in the repository's root does not run", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(root, { recursive: true })
    git(root, "init", "-q")
    // hostname.exe in git's place would print the computer's name instead of the repository's root.
    await fs.copyFile(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "hostname.exe"),
      path.join(root, "git.exe"),
    )
    const top = (await UntrustedGit.run(root, ["rev-parse", "--show-toplevel"])).trim()
    expect(top.toLowerCase()).not.toBe(os.hostname().toLowerCase())
    expect(top.replace(/\\/g, "/").toLowerCase().endsWith("/repo")).toBe(true)
  })
})

describe.skipIf(process.platform === "win32")("UntrustedGit.run", () => {
  test("reads history and the file list without running the repository's programs", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "repo")
    await fs.mkdir(path.join(root, "src"), { recursive: true })
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1\n")
    git(root, "init", "-q")
    signedCommit(root)
    const planted = await plant(root)
    const files = await UntrustedGit.run(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    const log = await UntrustedGit.run(root, ["log", "--no-merges", "--format=%H", "--name-only", "-n", "5"])
    expect(files.split("\0").filter(Boolean)).toEqual(["src/a.ts"])
    expect(log).toContain("src/a.ts")
    expect(await planted.ran()).toBe("")
  })

  test("gives git an environment without Vector's secrets", async () => {
    await using tmp = await tmpdir()
    // An alias of Vector's own prints what a program git starts would be given.
    const env = await UntrustedGit.run(tmp.path, [
      "-c",
      'alias.environment=!echo "key=${VECTOR_CREDENTIAL_KEY-unset} lazy=$GIT_NO_LAZY_FETCH"',
      "environment",
    ])
    expect(env.trim()).toBe("key=unset lazy=1")
  })
})
