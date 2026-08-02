import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename } from "node:path"

import { createRepo, getGithubToken } from "./github-auth"

// Push a Vector project straight to GitHub. Two paths share the git plumbing:
// - publishToGithub: BYOK via the USER's own `gh` CLI login (kept as fallback),
//   so Vector never sees or stores a GitHub token.
// - pushWithOauth: Vector's built-in device-flow sign-in (github-auth.ts) —
//   pushes over HTTPS with the stored OAuth token, no gh CLI required.

export type GithubStatus = {
  ghInstalled: boolean
  authenticated: boolean
  login?: string // gh username when authenticated
  detail: string // human hint, e.g. "Run `gh auth login` in Terminal."
}

export type GithubPublishInput = {
  projectPath: string
  name?: string
  private?: boolean
  description?: string
  commitMessage?: string
}

export type GithubPublishResult = { ok: boolean; url?: string; error?: string; log: string }

export type GithubPullRequestInput = {
  projectPath: string
  title: string
  body?: string
}

export type GithubPullRequestResult = { ok: boolean; url?: string; error?: string; log: string }

type RunResult = { stdout: string; stderr: string; failed: boolean; code: number | null }

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<RunResult>((resolve) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 10_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const err = error as (Error & { code?: number | string }) | null
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          failed: Boolean(err),
          code: typeof err?.code === "number" ? err.code : err ? null : 0,
        })
      },
    )
  })
}

// One push at a time per project so a double-click can't fire two `gh repo
// create` runs at once.
const activeGithubPublishes = new Set<string>()

export async function detectGithub(): Promise<GithubStatus> {
  const version = await run("gh", ["--version"], { timeoutMs: 10_000 })
  if (version.failed) {
    return {
      ghInstalled: false,
      authenticated: false,
      detail: "Install the GitHub CLI (gh) and run `gh auth login`.",
    }
  }
  // gh writes `auth status` to stderr on older releases, stdout on newer ones —
  // read both. It prints "Logged in to github.com account <login>" (newer) or
  // "Logged in to github.com as <login>" (older).
  const status = await run("gh", ["auth", "status"], { timeoutMs: 10_000 })
  const output = `${status.stdout}\n${status.stderr}`
  const authenticated = /logged in to/i.test(output)
  const login =
    output.match(/logged in to \S+ account (\S+)/i)?.[1] ?? output.match(/logged in to \S+ as (\S+)/i)?.[1]
  if (authenticated) {
    return {
      ghInstalled: true,
      authenticated: true,
      login,
      detail: login ? `Signed in to GitHub as ${login}.` : "Signed in to GitHub.",
    }
  }
  return {
    ghInstalled: true,
    authenticated: false,
    detail: "Run `gh auth login` in Terminal to connect your GitHub account.",
  }
}

// Turn a project folder name into a valid GitHub repo name: keep alnum plus
// - _ . , map spaces to -, strip everything else, fall back to "vector-app".
function slugifyRepoName(raw: string): string {
  const slug = (raw ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
  return slug || "vector-app"
}

function lastLines(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join("\n")
}

// Only inject a throwaway identity when the repo has none, so we never override
// the user's own git config.
async function buildCommitArgs(projectPath: string, message: string): Promise<string[]> {
  const email = await run("git", ["config", "user.email"], { cwd: projectPath, timeoutMs: 10_000 })
  const hasEmail = !email.failed && email.stdout.trim().length > 0
  const identity = hasEmail ? [] : ["-c", "user.name=Vector", "-c", "user.email=noreply@vectordev.ai"]
  return [...identity, "commit", "-m", message]
}

async function viewRepoUrl(projectPath: string): Promise<string | undefined> {
  const view = await run("gh", ["repo", "view", "--json", "url", "-q", ".url"], {
    cwd: projectPath,
    timeoutMs: 20_000,
  })
  const url = view.stdout.trim()
  return !view.failed && url.startsWith("http") ? url : undefined
}

async function viewPullRequestUrl(projectPath: string): Promise<string | undefined> {
  const view = await run("gh", ["pr", "view", "--json", "url", "-q", ".url"], {
    cwd: projectPath,
    timeoutMs: 20_000,
  })
  const url = view.stdout.trim()
  return !view.failed && url.startsWith("http") ? url : undefined
}

export async function createPullRequest(input: GithubPullRequestInput): Promise<GithubPullRequestResult> {
  const stats = input.projectPath ? await stat(input.projectPath).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) return { ok: false, log: "", error: "The isolated workspace no longer exists." }

  const github = await detectGithub()
  if (!github.ghInstalled || !github.authenticated) {
    return {
      ok: false,
      log: "",
      error: github.ghInstalled
        ? "Sign in with `gh auth login`, then try opening the pull request again."
        : "Install GitHub CLI and sign in with `gh auth login` before opening a pull request.",
    }
  }

  const logs: string[] = []
  const record = (label: string, result: RunResult) => {
    logs.push(`$ ${label}`)
    const text = `${result.stdout}${result.stderr}`.trim()
    if (text) logs.push(text)
  }
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: input.projectPath })
  record("git remote get-url origin", origin)
  if (origin.failed || !origin.stdout.trim()) {
    return { ok: false, log: logs.join("\n"), error: "Connect this project to a GitHub repository first." }
  }

  const branchResult = await run("git", ["branch", "--show-current"], { cwd: input.projectPath })
  const branch = branchResult.stdout.trim()
  record("git branch --show-current", branchResult)
  if (branchResult.failed || !branch) {
    return { ok: false, log: logs.join("\n"), error: "Vector could not determine the isolated workspace branch." }
  }

  const add = await run("git", ["add", "-A"], { cwd: input.projectPath, timeoutMs: 60_000 })
  record("git add -A", add)
  if (add.failed) return { ok: false, log: logs.join("\n"), error: lastLines(add.stderr, 4) || "Git could not stage the workspace changes." }

  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: input.projectPath })
  if (staged.failed) {
    const commit = await run("git", await buildCommitArgs(input.projectPath, input.title), {
      cwd: input.projectPath,
      timeoutMs: 30_000,
    })
    record(`git commit -m "${input.title}"`, commit)
    if (commit.failed) {
      return { ok: false, log: logs.join("\n"), error: lastLines(commit.stderr, 4) || "Git could not commit the workspace changes." }
    }
  }

  const push = await run("git", ["push", "-u", "origin", branch], {
    cwd: input.projectPath,
    timeoutMs: 120_000,
  })
  record(`git push -u origin ${branch}`, push)
  if (push.failed) {
    return {
      ok: false,
      log: logs.join("\n"),
      error: lastLines(`${push.stdout}\n${push.stderr}`, 4) || "GitHub rejected the workspace branch push.",
    }
  }

  const existing = await viewPullRequestUrl(input.projectPath)
  if (existing) return { ok: true, url: existing, log: logs.join("\n") }
  const args = ["pr", "create", "--title", input.title, "--body", input.body?.trim() || "Created from an isolated Vector agent workspace."]
  const created = await run("gh", args, { cwd: input.projectPath, timeoutMs: 120_000 })
  record(`gh pr create --title "${input.title}"`, created)
  const url = `${created.stdout}\n${created.stderr}`.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0]
  if (!created.failed && url) return { ok: true, url, log: logs.join("\n") }
  if (!created.failed) return { ok: true, url: await viewPullRequestUrl(input.projectPath), log: logs.join("\n") }
  return {
    ok: false,
    log: logs.join("\n"),
    error: lastLines(`${created.stdout}\n${created.stderr}`, 4) || "GitHub could not create the pull request.",
  }
}

function remoteUrl(value: string): string | undefined {
  const url = value.trim()
  if (!url) return
  if (url.startsWith("http://") || url.startsWith("https://")) return url.replace(/\.git$/, "")
  const ssh = url.match(/^git@github\.com:(.+)$/)
  if (!ssh) return
  return `https://github.com/${ssh[1].replace(/\.git$/, "")}`
}

type RecordFn = (label: string, result: RunResult) => void

// Shared by both push paths: make sure the folder is a git repo with the
// working tree committed. Returns an error string on failure, undefined when
// the tree is ready to push ("nothing to commit" still counts as ready).
async function prepareCommit(
  projectPath: string,
  commitMessage: string | undefined,
  record: RecordFn,
): Promise<string | undefined> {
  const insideRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectPath,
    timeoutMs: 10_000,
  })
  if (insideRepo.failed || !/true/.test(insideRepo.stdout)) {
    const init = await run("git", ["init"], { cwd: projectPath, timeoutMs: 15_000 })
    record("git init", init)
    if (init.failed) return "Couldn't initialize a git repository in this folder."
  }

  const add = await run("git", ["add", "-A"], { cwd: projectPath, timeoutMs: 60_000 })
  record("git add -A", add)

  const hasCommits = !(await run("git", ["rev-parse", "--verify", "HEAD"], { cwd: projectPath, timeoutMs: 10_000 }))
    .failed
  const staged = await run("git", ["diff", "--cached", "--quiet"], { cwd: projectPath, timeoutMs: 15_000 })
  const dirty = staged.failed // `--quiet` exits non-zero when there are staged changes
  if (!hasCommits || dirty) {
    const message = commitMessage?.trim() || (hasCommits ? "Update from Vector" : "Initial commit from Vector")
    const commit = await run("git", await buildCommitArgs(projectPath, message), {
      cwd: projectPath,
      timeoutMs: 30_000,
    })
    record(`git commit -m "${message}"`, commit)
    const nothingToCommit = /nothing to commit/i.test(`${commit.stdout}${commit.stderr}`)
    if (commit.failed && !nothingToCommit && !hasCommits) {
      return "Couldn't create the first commit. Make sure git is configured, then try again."
    }
  }
}

export async function publishToGithub(input: GithubPublishInput): Promise<GithubPublishResult> {
  const projectPath = input.projectPath
  const stats = projectPath ? await stat(projectPath).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) {
    return { ok: false, log: "", error: "Open a project folder before pushing to GitHub." }
  }
  if (activeGithubPublishes.has(projectPath)) {
    return { ok: false, log: "", error: "A GitHub push is already running for this project." }
  }

  const name = slugifyRepoName(input.name || basename(projectPath))
  const visibility = input.private === false ? "--public" : "--private"

  const logs: string[] = []
  const record = (label: string, result: RunResult) => {
    logs.push(`$ ${label}`)
    const text = `${result.stdout}${result.stderr}`.trim()
    if (text) logs.push(text)
  }

  activeGithubPublishes.add(projectPath)
  try {
    // 1-2. Make sure the folder is a git repo with everything committed.
    const commitError = await prepareCommit(projectPath, input.commitMessage, record)
    if (commitError) return { ok: false, log: logs.join("\n"), error: commitError }

    // 3. Existing repositories should behave like a normal Push button. Only
    //    create a GitHub repository when this project has no origin yet.
    const origin = await run("git", ["remote", "get-url", "origin"], {
      cwd: projectPath,
      timeoutMs: 10_000,
    })
    if (!origin.failed && origin.stdout.trim()) {
      const branchResult = await run("git", ["branch", "--show-current"], {
        cwd: projectPath,
        timeoutMs: 10_000,
      })
      const branch = branchResult.stdout.trim() || "main"
      const push = await run("git", ["push", "-u", "origin", branch], {
        cwd: projectPath,
        timeoutMs: 120_000,
      })
      record(`git push -u origin ${branch}`, push)
      if (!push.failed) {
        return {
          ok: true,
          url: (await viewRepoUrl(projectPath)) ?? remoteUrl(origin.stdout),
          log: logs.join("\n"),
        }
      }

      const output = `${push.stdout}\n${push.stderr}`
      const lower = output.toLowerCase()
      const error = /non-fast-forward|fetch first|rejected/.test(lower)
        ? "GitHub has newer commits. Pull and resolve them before pushing again."
        : /permission denied|repository not found|could not read from remote/.test(lower)
          ? "GitHub rejected this push. Check that your account can write to the repository and that the origin URL is correct."
          : lastLines(output, 4) || `git push exited with code ${push.code ?? "unknown"}.`
      return { ok: false, log: logs.join("\n"), error }
    }

    // 4. Creating a new remote is the only operation that requires GitHub CLI.
    // Existing remotes use the user's normal Git credential helper or SSH agent.
    const github = await detectGithub()
    if (!github.ghInstalled) {
      return {
        ok: false,
        log: logs.join("\n"),
        error: "This project has no GitHub origin yet. Install GitHub CLI, run `gh auth login`, then try again.",
      }
    }
    if (!github.authenticated) {
      return {
        ok: false,
        log: logs.join("\n"),
        error: "This project has no GitHub origin yet. Run `gh auth login`, then try again.",
      }
    }

    // 5. Create the remote repo and push in one shot.
    const createArgs = ["repo", "create", name, "--source", ".", "--push", visibility]
    if (input.description?.trim()) createArgs.push("--description", input.description.trim())
    const create = await run("gh", createArgs, { cwd: projectPath, timeoutMs: 120_000 })
    record(`gh ${createArgs.join(" ")}`, create)

    const combined = `${create.stdout}\n${create.stderr}`
    if (!create.failed) {
      const url =
        combined.match(/https:\/\/github\.com\/\S+/i)?.[0]?.replace(/[).,]+$/, "") ??
        (await viewRepoUrl(projectPath))
      return { ok: true, url, log: logs.join("\n") }
    }

    // 6. Map common gh failures to friendly errors.
    const lower = combined.toLowerCase()
    let error: string
    if (/gh auth login|not logged in|authentication required|requires authentication/.test(lower)) {
      error = "You're not signed in to GitHub. Run `gh auth login` in Terminal, then try again."
    } else if (/name already exists|already exists on this account/.test(lower)) {
      error = `A repository named "${name}" already exists on your account. Try a different name.`
    } else if (/no commits|does not have any commits|nothing to commit/.test(lower)) {
      error = "This project has no commits to push yet. Add some files, then try again."
    } else {
      error = lastLines(combined, 4) || `gh exited with code ${create.code ?? "unknown"}.`
    }
    return { ok: false, log: logs.join("\n"), error }
  } catch (error) {
    // Never throw out of here — always resolve a result object.
    return { ok: false, log: logs.join("\n"), error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeGithubPublishes.delete(projectPath)
  }
}

// ---- OAuth (device flow) push --------------------------------------------

export type GithubOauthPushInput = {
  projectPath: string
  repo?: { owner: string; name: string }
  createNew?: { name: string; private: boolean; description?: string }
  commitMessage?: string
}

// git authenticates OAuth pushes over HTTPS with a one-shot header passed via
// `-c http.<url>.extraheader=...`. The token rides inside basic auth as
// "x-access-token:<token>" — GitHub's documented convention for OAuth/app
// tokens. Exported for unit tests.
export function buildOauthPushHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`
}

// Parse "owner/name" out of an existing GitHub remote (https or ssh form).
// Exported for unit tests.
export function parseGithubRemote(raw: string): { owner: string; name: string } | undefined {
  const url = raw.trim()
  const match =
    url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i) ??
    url.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (!match) return
  return { owner: match[1], name: match[2] }
}

// Push using the token from Vector's built-in GitHub sign-in (github-auth.ts).
// The token is passed to git as a per-invocation config header — NEVER written
// to .git/config, never embedded in the remote URL, never logged.
export async function pushWithOauth(input: GithubOauthPushInput): Promise<GithubPublishResult> {
  const projectPath = input.projectPath
  const stats = projectPath ? await stat(projectPath).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) {
    return { ok: false, log: "", error: "Open a project folder before pushing to GitHub." }
  }
  if (activeGithubPublishes.has(projectPath)) {
    return { ok: false, log: "", error: "A GitHub push is already running for this project." }
  }
  const token = await getGithubToken()
  if (!token) return { ok: false, log: "", error: "Sign in to GitHub first." }

  const logs: string[] = []
  const record: RecordFn = (label, result) => {
    logs.push(`$ ${label}`)
    const text = `${result.stdout}${result.stderr}`.trim()
    if (text) logs.push(text)
  }

  activeGithubPublishes.add(projectPath)
  try {
    // 1. Make sure the folder is a git repo with everything committed.
    const commitError = await prepareCommit(projectPath, input.commitMessage, record)
    if (commitError) return { ok: false, log: logs.join("\n"), error: commitError }

    // 2. Resolve the target repository: create it, take the caller's pick, or
    //    fall back to the existing origin remote.
    let owner: string
    let name: string
    let htmlUrl: string | undefined
    if (input.createNew) {
      try {
        const repo = await createRepo(input.createNew)
        logs.push(`Created repository ${repo.fullName}`)
        owner = repo.owner
        name = repo.name
        htmlUrl = repo.htmlUrl
      } catch (error) {
        return {
          ok: false,
          log: logs.join("\n"),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    } else if (input.repo) {
      owner = input.repo.owner
      name = input.repo.name
    } else {
      const origin = await run("git", ["remote", "get-url", "origin"], { cwd: projectPath, timeoutMs: 10_000 })
      const parsed = origin.failed ? undefined : parseGithubRemote(origin.stdout)
      if (!parsed) {
        return { ok: false, log: logs.join("\n"), error: "Choose a GitHub repository to push to." }
      }
      owner = parsed.owner
      name = parsed.name
    }
    const pushUrl = `https://github.com/${owner}/${name}.git`
    htmlUrl ??= `https://github.com/${owner}/${name}`

    // 3. Adopt the repo as origin when the project has no remote yet, but push
    //    explicitly to the URL either way so an unrelated origin can't hijack
    //    the push target.
    const origin = await run("git", ["remote", "get-url", "origin"], { cwd: projectPath, timeoutMs: 10_000 })
    if (origin.failed || !origin.stdout.trim()) {
      const addRemote = await run("git", ["remote", "add", "origin", pushUrl], {
        cwd: projectPath,
        timeoutMs: 10_000,
      })
      record(`git remote add origin ${pushUrl}`, addRemote)
    }

    const branchResult = await run("git", ["branch", "--show-current"], { cwd: projectPath, timeoutMs: 10_000 })
    const branch = branchResult.stdout.trim() || "main"

    // 4. Push. The auth header lives only in this one argv — the log label
    //    below deliberately omits the `-c` flag so the token never lands in
    //    the returned log.
    const push = await run(
      "git",
      ["-c", `http.https://github.com/.extraheader=${buildOauthPushHeader(token)}`, "push", pushUrl, `HEAD:${branch}`],
      { cwd: projectPath, timeoutMs: 120_000 },
    )
    record(`git push ${pushUrl} HEAD:${branch}`, push)
    if (!push.failed) return { ok: true, url: htmlUrl, log: logs.join("\n") }

    // 5. Map common git failures to friendly errors.
    const combined = `${push.stdout}\n${push.stderr}`
    const lower = combined.toLowerCase()
    let error: string
    if (/non-fast-forward|fetch first|rejected/.test(lower)) {
      error = "GitHub has newer commits. Pull and resolve them before pushing again."
    } else if (/error: 403|permission to .* denied|write access to repository not granted|protected branch/.test(lower)) {
      error =
        "GitHub rejected this push (403). Your token may lack access to this repository — if it belongs to an organization, authorize SSO for Vector, then try again."
    } else if (/error: 401|authentication failed|invalid username or password/.test(lower)) {
      error = "GitHub rejected the token. Sign out of GitHub in Vector, sign in again, then retry."
    } else if (/repository not found|could not read from remote/.test(lower)) {
      error = `Repository ${owner}/${name} was not found. Check the name and your access.`
    } else {
      error = lastLines(combined, 4) || `git push exited with code ${push.code ?? "unknown"}.`
    }
    return { ok: false, log: logs.join("\n"), error }
  } catch (error) {
    // Never throw out of here — always resolve a result object.
    return { ok: false, log: logs.join("\n"), error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeGithubPublishes.delete(projectPath)
  }
}
