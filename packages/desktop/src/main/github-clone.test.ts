import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let home = tmpdir()
const electronMock = {
  app: { getPath: () => home, isPackaged: false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))

const {
  cancelGithubClone,
  cancelGithubClonesFor,
  classifyCloneFailure,
  cloneGithubRepository,
  cloneParentFrom,
  defaultCloneParent,
  gitCloneEnvironment,
  gitInstallHint,
  parseCloneFolder,
  parseCloneProgress,
  parseGithubCloneSource,
  repositoryLookupResult,
} = await import("./github-clone")
const { buildOauthPushHeader } = await import("./github")

const TOKEN = "gho_0123456789abcdefghijklmnopqrstuvwxyz"

describe("parseGithubCloneSource", () => {
  test("accepts owner/name and github.com links in every common form", () => {
    const inputs = [
      "octocat/Hello-World",
      "https://github.com/octocat/Hello-World",
      "https://github.com/octocat/Hello-World.git",
      "https://github.com/octocat/Hello-World/",
      "https://github.com/octocat/Hello-World.git/",
      "http://github.com/octocat/Hello-World",
      "github.com/octocat/Hello-World",
      "www.github.com/octocat/Hello-World",
      "https://GitHub.com/octocat/Hello-World",
      "git@github.com:octocat/Hello-World.git",
      "git@github.com:octocat/Hello-World",
      "ssh://git@github.com/octocat/Hello-World.git",
      "https://github.com/octocat/Hello-World/tree/main/src?tab=readme-ov-file#x",
      "  octocat/Hello-World  ",
    ]
    for (const input of inputs) {
      expect({ input, result: parseGithubCloneSource(input) }).toEqual({
        input,
        result: { ok: true, repo: { owner: "octocat", name: "Hello-World" } },
      })
    }
    expect(parseGithubCloneSource("octo/.github")).toEqual({ ok: true, repo: { owner: "octo", name: ".github" } })
  })

  test("rejects credentials, other hosts and schemes, and invalid names without echoing the input", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /Enter a repository/],
      ["https://user:pass@github.com/o/n", /Remove the username or token/],
      [`https://${TOKEN}@github.com/o/n`, /Remove the username or token/],
      ["ssh://alice@github.com/o/n", /Remove the username or token/],
      ["https://gitlab.com/o/n", /only clone repositories from github\.com/],
      ["https://github.com:8443/o/n", /only clone repositories from github\.com/],
      ["github.com.evil.com/o/n", /only clone repositories from github\.com/],
      ["https://github.com./o/n", /only clone repositories from github\.com/],
      ["file:///tmp/repo", /only clone repositories from github\.com/],
      ["ext::sh -c id/x", /only clone repositories from github\.com/],
      ["git@evil.com:o/n", /only clone repositories from github\.com/],
      ["-o/n", /isn't a valid GitHub repository/],
      ["o/-n", /isn't a valid GitHub repository/],
      ["o/..", /isn't a valid GitHub repository/],
      ["o/.", /isn't a valid GitHub repository/],
      ["o", /isn't a valid GitHub repository/],
      ["https://github.com/o", /isn't a valid GitHub repository/],
      ["ssh://git@github.com/o/n/extra", /isn't a valid GitHub repository/],
      ["o--x/n", /isn't a valid GitHub repository/],
      ["o/n with space", /only clone repositories from github\.com|isn't a valid/],
    ]
    for (const [input, message] of cases) {
      const result = parseGithubCloneSource(input)
      expect({ input, ok: result.ok }).toEqual({ input, ok: false })
      if (result.ok) continue
      expect(result.error).toMatch(message)
      if (input.length > 8) expect(result.error).not.toContain(input)
      expect(result.error).not.toContain(TOKEN)
    }
  })
})

describe("parseCloneFolder", () => {
  test("rejects names that are unsafe or unportable", () => {
    for (const input of [
      "",
      "   ",
      "a/b",
      "a\\b",
      "a:b",
      "a*b",
      ".",
      "..",
      "-x",
      "con",
      "CON.txt",
      "lpt1",
      "x.",
      "x ",
      "a\u0001",
      "x".repeat(256),
    ]) {
      expect({ input, ok: parseCloneFolder(input).ok }).toEqual({ input, ok: false })
    }
  })

  test("accepts ordinary repository names", () => {
    expect(parseCloneFolder("Hello-World")).toEqual({ ok: true, folder: "Hello-World" })
    expect(parseCloneFolder(".github")).toEqual({ ok: true, folder: ".github" })
    expect(parseCloneFolder("console")).toEqual({ ok: true, folder: "console" })
  })
})

describe("parseCloneProgress", () => {
  test("maps git's phases onto one rising percentage", () => {
    expect(parseCloneProgress("Receiving objects:  42% (42/100), 1.00 MiB | 2.00 MiB/s")).toEqual({
      phase: "receiving",
      percent: 37,
    })
    expect(parseCloneProgress("remote: Counting objects:  50% (1/2)")).toEqual({ phase: "starting", percent: 3 })
    expect(parseCloneProgress("Resolving deltas: 100% (5/5), done.")).toEqual({ phase: "resolving", percent: 95 })
    expect(parseCloneProgress("Updating files: 100% (3/3), done.")).toEqual({ phase: "checkout", percent: 100 })
    expect(parseCloneProgress("Cloning into 'n'...")).toBeUndefined()
    expect(parseCloneProgress("remote: Enumerating objects: 5, done.")).toBeUndefined()
  })
})

describe("classifyCloneFailure", () => {
  const context = (signedIn: boolean) => ({ signedIn, repo: "acme/app", owner: "acme", parent: "/work" })

  test("maps git's English errors to kinds and messages", () => {
    const cases: Array<[string, boolean, string, RegExp]> = [
      [
        "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools)",
        false,
        "git-missing",
        /xcode-select --install/,
      ],
      [
        "xcode-select: note: No developer tools were found, requesting install.\nIf developer tools are located at a non-default location on disk, use `sudo xcode-select --switch path`.",
        false,
        "git-missing",
        /xcode-select --install/,
      ],
      [
        "remote: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
        true,
        "auth",
        /acme requires single sign-on/,
      ],
      [
        "remote: The 'acme' organization has enabled or enforced SAML SSO.",
        true,
        "auth",
        /acme requires single sign-on/,
      ],
      ["git@github.com: Permission denied (publickey).", false, "auth", /SSH key/],
      [
        "fatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403",
        true,
        "auth",
        /refused access to acme\/app/,
      ],
      [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        false,
        "auth",
        /If it's a private repository, connect GitHub/,
      ],
      [
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        true,
        "not-found",
        /doesn't have access/,
      ],
      ["fatal: repository 'https://github.com/acme/app.git/' not found", false, "auth", /connect GitHub/],
      ["remote: Repository not found.", true, "not-found", /couldn't find acme\/app/],
      [
        "fatal: unable to access 'https://github.com/acme/app.git/': SSL certificate problem: unable to get local issuer certificate",
        false,
        "network",
        /http\.sslCAInfo/,
      ],
      ["error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly", false, "network", /stalled or dropped/],
      [
        "error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds",
        false,
        "network",
        /stalled or dropped/,
      ],
      [
        "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
        false,
        "network",
        /Couldn't reach GitHub/,
      ],
      [
        "fatal: unable to access 'https://github.com/acme/app.git/': CONNECT tunnel failed, response 403",
        false,
        "network",
        /Couldn't reach GitHub/,
      ],
      ["fatal: write error: No space left on device", false, "disk", /enough free disk space in \/work/],
      ["error: unable to create file src/very/long/path.ts: Filename too long", false, "disk", /core\.longpaths/],
      ["fatal: could not create work tree dir 'app': Permission denied", false, "disk", /can't write to \/work/],
      ["fatal: something new went wrong", false, "failed", /Git couldn't clone acme\/app/],
    ]
    for (const [output, signedIn, kind, message] of cases) {
      const result = classifyCloneFailure(`Cloning into 'app'...\n${output}\n`, context(signedIn))
      expect({ output, signedIn, kind: result.kind }).toEqual({ output, signedIn, kind })
      expect(result.error).toMatch(message)
    }
  })

  test("owner, repository and folder names never pick a rule", () => {
    const cases: Array<[string, { repo: string; owner: string; parent: string }, string, string]> = [
      [
        "Cloning into '/Users/samlewis/Developer/.app.vector-partial-0a1b2c3d'...\nremote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found",
        { repo: "acme/app", owner: "acme", parent: "/Users/samlewis/Developer" },
        "not-found",
        "GitHub couldn't find acme/app",
      ],
      [
        "Cloning into '/work/.python3-saml.vector-partial-0a1b2c3d'...\nfatal: unable to access 'https://github.com/SAML-Toolkits/python3-saml.git/': Could not resolve host: github.com",
        { repo: "SAML-Toolkits/python3-saml", owner: "SAML-Toolkits", parent: "/work" },
        "network",
        "Couldn't reach GitHub",
      ],
      [
        "Cloning into '/work/.permission denied.vector-partial-0a1b2c3d'...\nfatal: unable to access 'https://github.com/acme/no-space-left.git/': Could not resolve host: github.com",
        { repo: "acme/no-space-left", owner: "acme", parent: "/work" },
        "network",
        "Couldn't reach GitHub",
      ],
    ]
    for (const [output, names, kind, message] of cases) {
      const result = classifyCloneFailure(output, { signedIn: true, ...names })
      expect({ output, kind: result.kind }).toEqual({ output, kind })
      expect(result.error).toContain(message)
    }
  })

  test("details carry the last fatal line with secrets redacted", () => {
    const result = classifyCloneFailure(
      `remote: noise\nfatal: unexpected answer ${TOKEN}\nhint: see the docs\n`,
      context(true),
    )
    expect(result.detail).toBe("fatal: unexpected answer [REDACTED]")
  })
})

describe("gitInstallHint", () => {
  test("names the platform's way to install git", () => {
    expect(gitInstallHint("darwin")).toContain("xcode-select --install")
    expect(gitInstallHint("win32")).toContain("git-scm.com")
    expect(gitInstallHint("win32")).toContain("winget install --id Git.Git -e")
    expect(gitInstallHint("linux")).toContain("apt")
  })
})

describe("repositoryLookupResult", () => {
  const repo = { owner: "acme", name: "app" }

  test("adopts GitHub's canonical name and visibility", () => {
    expect(repositoryLookupResult(repo, false, 200, { full_name: "acme-inc/renamed-app", private: false })).toEqual({
      ok: true,
      repo: { owner: "acme-inc", name: "renamed-app" },
      private: false,
    })
  })

  test("reports clear access problems and lets git decide everything else", () => {
    expect(repositoryLookupResult(repo, true, 401, {})).toMatchObject({ ok: false, kind: "auth", expired: true })
    expect(repositoryLookupResult(repo, true, 404, {})).toMatchObject({ ok: false, kind: "not-found" })
    expect(repositoryLookupResult(repo, false, 404, {})).toEqual({ ok: true, repo })
    expect(
      repositoryLookupResult(repo, true, 403, { message: "Resource protected by organization SAML enforcement." }),
    ).toMatchObject({ ok: false, kind: "auth", error: expect.stringContaining("acme requires single sign-on") })
    expect(
      repositoryLookupResult(repo, true, 403, {
        message:
          "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions.",
      }),
    ).toMatchObject({ ok: false, kind: "auth", error: expect.stringContaining("blocks apps") })
    expect(repositoryLookupResult(repo, false, 403, { message: "API rate limit exceeded" })).toEqual({ ok: true, repo })
    expect(repositoryLookupResult(repo, true, undefined, undefined)).toEqual({ ok: true, repo })
    expect(repositoryLookupResult(repo, true, 200, { full_name: "../../x" })).toEqual({
      ok: true,
      repo,
      private: undefined,
    })
  })
})

describe("gitCloneEnvironment", () => {
  const base = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/ada",
    GIT_SSL_CAINFO: "/etc/ca.pem",
    GIT_ASKPASS: "/usr/bin/askpass",
    SSH_ASKPASS: "/usr/bin/ssh-askpass",
    GIT_CONFIG_PARAMETERS: "'credential.helper'='store'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic leaked",
    GIT_TRACE_CURL: "1",
    GIT_DIR: "/elsewhere/.git",
    VECTOR_CLOUD_TOKEN: "vector-secret",
  }
  const pairs = (env: Record<string, string | undefined>) =>
    Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, index) => [
      env[`GIT_CONFIG_KEY_${index}`],
      env[`GIT_CONFIG_VALUE_${index}`],
    ])

  test("with a token, includes the private auth config after a reset and never carries the header itself", () => {
    const env = gitCloneEnvironment(base, "/private/tmp/vector-git-auth-1-x/auth.gitconfig")
    expect(pairs(env)).toEqual([
      ["core.askPass", ""],
      ["http.https://github.com/.extraheader", ""],
      ["http.lowSpeedLimit", "1000"],
      ["http.lowSpeedTime", "60"],
      ["credential.helper", ""],
      ["http.followRedirects", "false"],
      ["include.path", "/private/tmp/vector-git-auth-1-x/auth.gitconfig"],
    ])
    expect(Object.values(env).some((value) => value?.toUpperCase().includes("AUTHORIZATION"))).toBe(false)
    for (const key of [
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "GIT_CONFIG_PARAMETERS",
      "GIT_TRACE_CURL",
      "GIT_DIR",
      "VECTOR_CLOUD_TOKEN",
    ]) {
      expect({ key, value: env[key as keyof typeof env] }).toEqual({ key, value: undefined })
    }
    expect(env).toMatchObject({
      PATH: "/usr/bin:/bin",
      GIT_SSL_CAINFO: "/etc/ca.pem",
      GIT_TERMINAL_PROMPT: "0",
      GIT_TRACE2: "0",
      GIT_TRACE2_EVENT: "0",
      GIT_TRACE2_PERF: "0",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C",
    })
  })

  test("without a token, sends no header and keeps the user's credential helpers", () => {
    const env = gitCloneEnvironment(base)
    expect(pairs(env)).toEqual([
      ["core.askPass", ""],
      ["http.https://github.com/.extraheader", ""],
      ["http.lowSpeedLimit", "1000"],
      ["http.lowSpeedTime", "60"],
    ])
    expect(Object.values(env).some((value) => value?.includes("leaked"))).toBe(false)
  })
})

describe("destination parent", () => {
  test("defaults stay out of synced Documents folders", () => {
    expect(defaultCloneParent("darwin", "/Users/ada")).toBe("/Users/ada/Developer")
    expect(defaultCloneParent("win32", "C:\\Users\\ada")).toBe("C:\\Users\\ada\\source\\repos")
    expect(defaultCloneParent("linux", "/home/ada")).toBe("/home/ada/Projects")
  })

  test("a remembered folder wins only while it is an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vector-clone-parent-"))
    await writeFile(join(root, "file"), "")
    expect(await cloneParentFrom(root, "/fallback")).toEqual({ path: root, isDefault: false })
    expect(await cloneParentFrom(join(root, "missing"), "/fallback")).toEqual({ path: "/fallback", isDefault: true })
    expect(await cloneParentFrom(join(root, "file"), "/fallback")).toEqual({ path: "/fallback", isDefault: true })
    expect(await cloneParentFrom("relative/path", "/fallback")).toEqual({ path: "/fallback", isDefault: true })
    expect(await cloneParentFrom(42, "/fallback")).toEqual({ path: "/fallback", isDefault: true })
    await rm(root, { recursive: true, force: true })
  })
})

// The fake git answers --version, records clone's argv, environment and the auth config it was told to include, and
// passes everything else (config --file, rev-parse) to the real git, so the existing-folder checks run against real
// repositories.
const FAKE_GIT = `#!/bin/sh
case "$1" in
  --version)
    if [ "$FAKE_GIT_MODE" = stub ]; then
      echo "xcode-select: note: No developer tools were found, requesting install." >&2
      exit 1
    fi
    echo "git version \${FAKE_GIT_VERSION:-2.43.0}"
    exit 0 ;;
  clone)
    printf '%s\\n' "$@" > "$FAKE_GIT_STATE/argv"
    env > "$FAKE_GIT_STATE/env"
    i=0
    while [ "$i" -lt "\${GIT_CONFIG_COUNT:-0}" ]; do
      eval "key=\\$GIT_CONFIG_KEY_$i value=\\$GIT_CONFIG_VALUE_$i"
      if [ "$key" = include.path ]; then
        printf '%s' "$value" > "$FAKE_GIT_STATE/auth-path"
        cat "$value" > "$FAKE_GIT_STATE/auth"
      fi
      i=$((i + 1))
    done
    case "$FAKE_GIT_MODE" in
      fail)
        echo "Cloning into '$5'..." >&2
        echo "fatal: repository 'https://github.com/o/n.git/' not found" >&2
        exit 128 ;;
      hang)
        echo partial > "$5/partial"
        sleep 30 &
        echo $! > "$FAKE_GIT_STATE/pid"
        wait
        exit 1 ;;
      squat)
        mkdir "$(dirname "$5")/n" ;;
    esac
    printf 'Receiving objects:   5%% (1/20)\\r' >&2
    printf 'Receiving objects:  50%% (10/20)\\r' >&2
    printf 'Receiving objects: 100%% (20/20), done.\\n' >&2
    printf 'Resolving deltas: 100%% (5/5), done.\\n' >&2
    mkdir -p "$5/.git"
    printf '[remote "origin"]\\n\\turl = %s\\n' "$4" > "$5/.git/config"
    exit 0 ;;
esac
exec "$REAL_GIT" "$@"
`

const realGit = Bun.which("git")
const runnable = process.platform !== "win32" && Boolean(realGit)

describe.skipIf(!runnable)("cloneGithubRepository", () => {
  let root = ""
  let parent = ""
  let state = ""
  let fakeGit = ""
  let sender = 100

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vector-clone-"))
    parent = join(root, "parent")
    state = join(root, "state")
    await mkdir(parent)
    await mkdir(state)
    fakeGit = join(root, "git")
    await writeFile(fakeGit, FAKE_GIT)
    await chmod(fakeGit, 0o755)
    sender += 1
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const environment = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH,
    HOME: root,
    REAL_GIT: realGit ?? "",
    FAKE_GIT_STATE: state,
    ...extra,
  })

  const start = (
    overrides: Partial<{ runId: string; repo: string; folder: string; parent: string }> = {},
    deps: Partial<Parameters<typeof cloneGithubRepository>[1]> = {},
  ) => {
    const events: Array<{ runId: string; phase: string; percent: number; message: string }> = []
    const runId = overrides.runId ?? `run-${sender}-${Math.random().toString(36).slice(2)}`
    const result = cloneGithubRepository(
      { runId, repo: "o/n", folder: "n", parent, ...overrides },
      {
        sender,
        emit: (event) => events.push(event),
        environment: environment(),
        git: fakeGit,
        parent: async () => ({ path: parent, isDefault: false }),
        token: async () => undefined,
        lookup: async (repo) => ({ ok: true, repo }),
        ...deps,
      },
    )
    return { runId, result, events }
  }

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    )

  // A killed process whose parent died can linger as a zombie until init reaps it, which still answers kill(pid, 0).
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return process.platform !== "linux" || !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"))
    } catch {
      return false
    }
  }

  const waitFor = async (path: string) => {
    for (let attempt = 0; attempt < 200 && !(await exists(path)); attempt++) await Bun.sleep(25)
  }

  test("clones into a hidden sibling, then moves it to parent/folder, with a fixed argv and rising progress", async () => {
    const run = start({}, { token: async () => TOKEN })
    const result = await run.result
    const target = join(parent, "n")
    expect(result).toEqual({ ok: true, directory: target, reused: false, fullName: "o/n" })
    const argv = (await readFile(join(state, "argv"), "utf8")).trim().split("\n")
    expect(argv.slice(0, 4)).toEqual(["clone", "--progress", "--", "https://github.com/o/n.git"])
    expect(argv[4]).toStartWith(join(parent, ".n.vector-partial-"))
    expect(argv).toHaveLength(5)
    expect(await readFile(join(target, ".git", "config"), "utf8")).toContain("https://github.com/o/n.git")
    expect(await readdir(parent)).toEqual(["n"])
    // The header reaches git only through a private file the environment includes: never argv or the environment.
    const env = await readFile(join(state, "env"), "utf8")
    const header = buildOauthPushHeader(TOKEN)
    expect(env).not.toContain(header.split(" ").at(-1)!)
    expect(env).not.toContain(TOKEN)
    expect(await readFile(join(state, "argv"), "utf8")).not.toContain("extraheader")
    expect(await readFile(join(state, "auth"), "utf8")).toContain(`extraheader = "${header}"`)
    const authPath = await readFile(join(state, "auth-path"), "utf8")
    expect(env).toContain(authPath)
    expect(await exists(authPath)).toBe(false)
    expect(run.events.every((event) => event.runId === run.runId)).toBe(true)
    const percents = run.events.map((event) => event.percent)
    expect(percents).toEqual([...percents].sort((a, b) => a - b))
    expect(run.events.at(0)).toMatchObject({ phase: "starting", percent: 0 })
    expect(run.events.at(-1)).toMatchObject({ phase: "resolving", percent: 95 })
  })

  test("a repository GitHub reports as public clones without the token", async () => {
    const result = await start(
      {},
      { token: async () => TOKEN, lookup: async (repo) => ({ ok: true, repo, private: false }) },
    ).result
    expect(result.ok).toBe(true)
    const env = await readFile(join(state, "env"), "utf8")
    expect(env).not.toContain("AUTHORIZATION")
    expect(env).not.toContain("include.path")
  })

  test("a later clone removes auth folders left by a Vector process that is gone", async () => {
    const dead = Bun.spawnSync(["true"]).pid
    const stale = join(tmpdir(), `vector-git-auth-${dead}-test${sender}`)
    const live = join(tmpdir(), `vector-git-auth-${process.ppid}-test${sender}`)
    await mkdir(stale)
    await mkdir(live)
    await writeFile(join(stale, "auth.gitconfig"), "secret")
    expect((await start({}, { token: async () => TOKEN }).result).ok).toBe(true)
    expect(await exists(stale)).toBe(false)
    expect(await exists(live)).toBe(true)
    await rm(live, { recursive: true, force: true })
  })

  test("cancel stops the whole process tree and removes only the folder this run created", async () => {
    await writeFile(join(parent, "keep.txt"), "mine")
    const run = start({}, { environment: environment({ FAKE_GIT_MODE: "hang" }) })
    await waitFor(join(state, "pid"))
    const pid = Number((await readFile(join(state, "pid"), "utf8")).trim())

    // Another window cannot cancel this run.
    cancelGithubClone(sender + 1000, run.runId)
    await Bun.sleep(100)
    expect(alive(pid)).toBe(true)

    cancelGithubClone(sender, run.runId)
    const result = await run.result
    expect(result).toMatchObject({ ok: false, kind: "canceled", error: "Clone canceled." })
    expect(await readdir(parent)).toEqual(["keep.txt"])
    expect(await readFile(join(parent, "keep.txt"), "utf8")).toBe("mine")
    await Bun.sleep(100)
    expect(alive(pid)).toBe(false)
  }, 15_000)

  test("a page that reloads or crashes cancels every run it started", async () => {
    const run = start({}, { environment: environment({ FAKE_GIT_MODE: "hang" }) })
    await waitFor(join(state, "pid"))
    const pid = Number((await readFile(join(state, "pid"), "utf8")).trim())
    cancelGithubClonesFor(sender + 1000)
    await Bun.sleep(100)
    expect(alive(pid)).toBe(true)
    cancelGithubClonesFor(sender)
    expect(await run.result).toMatchObject({ ok: false, kind: "canceled" })
    expect(await readdir(parent)).toEqual([])
  }, 15_000)

  test("a failed clone maps git's error and removes the partial folder", async () => {
    const result = await start({}, { environment: environment({ FAKE_GIT_MODE: "fail" }) }).result
    expect(result).toMatchObject({
      ok: false,
      kind: "auth",
      error: "GitHub couldn't find o/n. If it's a private repository, connect GitHub and try again.",
      detail: "fatal: repository 'https://github.com/o/n.git/' not found",
    })
    expect(await readdir(parent)).toEqual([])
  })

  test("a folder that appears while cloning is never replaced", async () => {
    const result = await start({}, { environment: environment({ FAKE_GIT_MODE: "squat" }) }).result
    expect(result).toMatchObject({ ok: false, kind: "exists", suggestedFolder: "n-2" })
    expect(await readdir(parent)).toEqual(["n"])
    expect(await readdir(join(parent, "n"))).toEqual([])
  })

  test("a folder that is something else is left alone and a free name is suggested", async () => {
    await mkdir(join(parent, "n"))
    await writeFile(join(parent, "n", "notes.txt"), "keep")
    const result = await start().result
    expect(result).toMatchObject({ ok: false, kind: "exists", suggestedFolder: "n-2" })
    expect(await readFile(join(parent, "n", "notes.txt"), "utf8")).toBe("keep")
    expect(await exists(join(state, "argv"))).toBe(false)
  })

  test("an existing finished clone of the same repository is opened instead of cloned", async () => {
    const target = join(parent, "n")
    execFileSync(realGit!, ["init", "-q", target])
    execFileSync(realGit!, ["-C", target, "remote", "add", "origin", "https://github.com/O/N.git"])
    execFileSync(realGit!, [
      "-C",
      target,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ])
    const result = await start().result
    expect(result).toEqual({ ok: true, directory: target, reused: true, fullName: "o/n" })
    expect(await exists(join(state, "argv"))).toBe(false)
  })

  test("an unfinished clone of the same repository is reported, not opened", async () => {
    const target = join(parent, "n")
    execFileSync(realGit!, ["init", "-q", target])
    execFileSync(realGit!, ["-C", target, "remote", "add", "origin", "https://github.com/o/n.git"])
    const result = await start().result
    expect(result).toMatchObject({ ok: false, kind: "exists", suggestedFolder: "n-2" })
    if (!result.ok) expect(result.error).toContain("unfinished clone")
    expect(await exists(target)).toBe(true)
  })

  test("a clone stopped during checkout is reported, not opened, although HEAD resolves", async () => {
    const target = join(parent, "n")
    execFileSync(realGit!, ["init", "-q", target])
    execFileSync(realGit!, ["-C", target, "remote", "add", "origin", "https://github.com/o/n.git"])
    execFileSync(realGit!, [
      "-C",
      target,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ])
    // Killed before the index was written.
    await rm(join(target, ".git", "index"))
    const missing = await start().result
    expect(missing).toMatchObject({ ok: false, kind: "exists", error: expect.stringContaining("unfinished clone") })
    // Killed while the index lock was held.
    execFileSync(realGit!, ["-C", target, "reset", "-q"])
    await writeFile(join(target, ".git", "index.lock"), "")
    const locked = await start().result
    expect(locked).toMatchObject({ ok: false, kind: "exists", error: expect.stringContaining("unfinished clone") })
    expect(await exists(join(target, ".git", "index.lock"))).toBe(true)
  })

  test("reports missing and outdated git", async () => {
    expect(await start({}, { git: join(root, "no-such-git") }).result).toMatchObject({
      ok: false,
      kind: "git-missing",
    })
    expect(await start({}, { environment: environment({ FAKE_GIT_VERSION: "2.25.1" }) }).result).toMatchObject({
      ok: false,
      kind: "git-outdated",
      error: expect.stringContaining("This computer has Git 2.25.1"),
    })
    // Apple's /usr/bin/git stub on a Mac without Command Line Tools.
    expect(await start({}, { environment: environment({ FAKE_GIT_MODE: "stub" }) }).result).toMatchObject({
      ok: false,
      kind: "git-missing",
      error: gitInstallHint(process.platform),
    })
    expect(await readdir(parent)).toEqual([])
  })

  test("refuses a second clone into the same folder and a parent the renderer made up", async () => {
    // Either may claim the folder first; the other must be refused.
    const results = await Promise.all([start().result, start().result])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, kind: "busy" })

    expect(await start({ folder: "other", parent: join(root, "elsewhere") }).result).toMatchObject({
      ok: false,
      kind: "invalid",
      error: expect.stringContaining("destination folder changed"),
    })
    expect(await start({ folder: "../escape" }).result).toMatchObject({ ok: false, kind: "invalid" })
    expect(await start({ repo: "https://evil.example/o/n", folder: "x" }).result).toMatchObject({
      ok: false,
      kind: "invalid",
    })
    expect(await start({ runId: "../bad id" }).result).toMatchObject({ ok: false, kind: "invalid" })
    expect(await exists(join(root, "escape"))).toBe(false)
  })

  test("real git keeps the token out of .git/config, the environment and trace2 logs", async () => {
    // Test-only: the user's own insteadOf (kept through GIT_CONFIG_GLOBAL) points github.com at a local bare
    // repository, so the real git runs the real clone path without the network. The same global config turns on
    // trace2 telemetry and a post-checkout hook, which sees what every hook, filter and helper (git-lfs) would see.
    const source = join(root, "source")
    const bare = join(root, "remote", "o", "n.git")
    execFileSync(realGit!, ["init", "-q", source])
    await writeFile(join(source, "README.md"), "hello\n")
    execFileSync(realGit!, ["-C", source, "add", "."])
    execFileSync(realGit!, ["-C", source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"])
    execFileSync(realGit!, ["clone", "-q", "--bare", source, bare])
    const globalConfig = join(root, "gitconfig")
    const hooks = join(root, "hooks")
    await mkdir(hooks)
    await writeFile(
      join(hooks, "post-checkout"),
      `#!/bin/sh\nenv > "${join(state, "hook-env")}"\ngit config --get-all http.https://github.com/.extraheader > "${join(state, "hook-header")}"\n`,
    )
    await chmod(join(hooks, "post-checkout"), 0o755)
    await writeFile(
      globalConfig,
      [
        `[url "file://${join(root, "remote")}/"]`,
        "\tinsteadOf = https://github.com/",
        '[protocol "file"]',
        "\tallow = always",
        "[core]",
        `\thooksPath = ${hooks}`,
        "[trace2]",
        `\tnormalTarget = ${join(state, "trace-normal")}`,
        `\teventTarget = ${join(state, "trace-event")}`,
        `\tperfTarget = ${join(state, "trace-perf")}`,
        "\tconfigParams = http.*,include.*",
        "\tenvVars = GIT_CONFIG_VALUE_6",
        "",
      ].join("\n"),
    )
    const run = start(
      {},
      {
        git: realGit!,
        token: async () => TOKEN,
        environment: environment({ GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" }),
      },
    )
    const result = await run.result
    const target = join(parent, "n")
    expect(result).toEqual({ ok: true, directory: target, reused: false, fullName: "o/n" })
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("hello\n")
    const config = await readFile(join(target, ".git", "config"), "utf8")
    expect(config).toContain("url = https://github.com/o/n.git")
    expect(config).not.toContain(TOKEN)
    expect(config).not.toContain(buildOauthPushHeader(TOKEN).split(" ").at(-1)!)
    expect(config.toLowerCase()).not.toContain("extraheader")
    expect(config.toLowerCase()).not.toContain("askpass")
    expect(run.events.every((event) => !event.message.includes(TOKEN))).toBe(true)
    // Children get the header through git's config, so LFS and helpers still authenticate, but never as a variable.
    const header = buildOauthPushHeader(TOKEN)
    expect((await readFile(join(state, "hook-header"), "utf8")).trim().split("\n").at(-1)).toBe(header)
    const hookEnv = await readFile(join(state, "hook-env"), "utf8")
    expect(hookEnv).not.toContain(header.split(" ").at(-1)!)
    expect(hookEnv).not.toContain(TOKEN)
    for (const trace of ["trace-normal", "trace-event", "trace-perf"]) {
      expect({ trace, written: await exists(join(state, trace)) }).toEqual({ trace, written: false })
    }
    // The private auth config is gone once git exits.
    const include = /GIT_CONFIG_VALUE_\d+=(.*auth\.gitconfig)$/m.exec(hookEnv)?.[1]
    expect(include).toBeDefined()
    expect(await exists(include!)).toBe(false)
  })
})
