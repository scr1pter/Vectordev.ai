import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"

import { createRepo, getGitlabToken } from "./gitlab-auth"

// Push a Vector project straight to GitLab using Vector's built-in device-flow
// sign-in (gitlab-auth.ts) — pushes over HTTPS with the stored OAuth token, no
// glab CLI required. Mirrors github.ts's pushWithOauth path. The git plumbing
// (run/prepareCommit) is duplicated rather than shared so the working GitHub
// path stays completely untouched.

export type GitlabPublishResult = { ok: boolean; url?: string; error?: string; log: string }

type RunResult = { stdout: string; stderr: string; failed: boolean; code: number | null }

function run(command: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  return new Promise<RunResult>((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        env: untrustedChildEnvironment(),
        timeout: opts.timeoutMs ?? 10_000,
        maxBuffer: 8 * 1024 * 1024,
      },
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

// One push at a time per project so a double-click can't fire two runs at once.
const activeGitlabPushes = new Set<string>()

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

type RecordFn = (label: string, result: RunResult) => void

// Make sure the folder is a git repo with the working tree committed. Returns an
// error string on failure, undefined when the tree is ready to push ("nothing to
// commit" still counts as ready).
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

// ---- OAuth (device flow) push ---------------------------------------------

export type GitlabOauthPushInput = {
  projectPath: string
  // An existing project chosen from the picker (pushed to via its real clone URL
  // so nested groups/subgroups resolve correctly).
  repo?: { pathWithNamespace: string; httpUrl: string; webUrl?: string }
  createNew?: { name: string; private: boolean; description?: string }
  commitMessage?: string
}

// git authenticates OAuth pushes over HTTPS with a one-shot header passed via
// `-c http.<url>.extraheader=...`. The token rides inside basic auth as
// "oauth2:<token>" — GitLab's documented convention for OAuth tokens. Exported
// for unit tests.
export function buildOauthPushHeader(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`oauth2:${token}`, "utf8").toString("base64")}`
}

// Normalize an existing GitLab remote (https or ssh form) into an https clone
// URL. Handles nested groups (a/b/c). Exported for unit tests.
export function parseGitlabRemote(raw: string): { pathWithNamespace: string; httpUrl: string } | undefined {
  const url = raw.trim()
  const match =
    url.match(/^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?\/?$/i) ?? url.match(/^git@gitlab\.com:(.+?)(?:\.git)?$/i)
  if (!match) return
  const pathWithNamespace = match[1].replace(/\/+$/, "")
  if (!pathWithNamespace) return
  return { pathWithNamespace, httpUrl: `https://gitlab.com/${pathWithNamespace}.git` }
}

// Push using the token from Vector's built-in GitLab sign-in (gitlab-auth.ts).
// The token is passed to git as a per-invocation config header — NEVER written
// to .git/config, never embedded in the remote URL, never logged.
export async function pushWithOauth(input: GitlabOauthPushInput): Promise<GitlabPublishResult> {
  const projectPath = input.projectPath
  const stats = projectPath ? await stat(projectPath).catch(() => undefined) : undefined
  if (!stats?.isDirectory()) {
    return { ok: false, log: "", error: "Open a project folder before pushing to GitLab." }
  }
  if (activeGitlabPushes.has(projectPath)) {
    return { ok: false, log: "", error: "A GitLab push is already running for this project." }
  }
  const token = getGitlabToken()
  if (!token) return { ok: false, log: "", error: "Sign in to GitLab first." }

  const logs: string[] = []
  const record: RecordFn = (label, result) => {
    logs.push(`$ ${label}`)
    const text = `${result.stdout}${result.stderr}`.trim()
    if (text) logs.push(text)
  }

  activeGitlabPushes.add(projectPath)
  try {
    // 1. Make sure the folder is a git repo with everything committed.
    const commitError = await prepareCommit(projectPath, input.commitMessage, record)
    if (commitError) return { ok: false, log: logs.join("\n"), error: commitError }

    // 2. Resolve the target project: create it, take the caller's pick, or fall
    //    back to the existing origin remote.
    let pushUrl: string
    let htmlUrl: string | undefined
    if (input.createNew) {
      try {
        const repo = await createRepo(input.createNew)
        logs.push(`Created project ${repo.pathWithNamespace}`)
        pushUrl = repo.httpUrl
        htmlUrl = repo.webUrl
      } catch (error) {
        return {
          ok: false,
          log: logs.join("\n"),
          error: error instanceof Error ? error.message : String(error),
        }
      }
    } else if (input.repo) {
      pushUrl = input.repo.httpUrl
      htmlUrl = input.repo.webUrl ?? `https://gitlab.com/${input.repo.pathWithNamespace}`
    } else {
      const origin = await run("git", ["remote", "get-url", "origin"], { cwd: projectPath, timeoutMs: 10_000 })
      const parsed = origin.failed ? undefined : parseGitlabRemote(origin.stdout)
      if (!parsed) {
        return { ok: false, log: logs.join("\n"), error: "Choose a GitLab project to push to." }
      }
      pushUrl = parsed.httpUrl
      htmlUrl = `https://gitlab.com/${parsed.pathWithNamespace}`
    }

    // 3. Adopt the project as origin when the folder has no remote yet, but push
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

    // 4. Push. The auth header lives only in this one argv — the log label below
    //    deliberately omits the `-c` flag so the token never lands in the log.
    const push = await run(
      "git",
      ["-c", `http.https://gitlab.com/.extraheader=${buildOauthPushHeader(token)}`, "push", pushUrl, `HEAD:${branch}`],
      { cwd: projectPath, timeoutMs: 120_000 },
    )
    record(`git push ${pushUrl} HEAD:${branch}`, push)
    if (!push.failed) return { ok: true, url: htmlUrl, log: logs.join("\n") }

    // 5. Map common git failures to friendly errors.
    const combined = `${push.stdout}\n${push.stderr}`
    const lower = combined.toLowerCase()
    let error: string
    if (/non-fast-forward|fetch first|rejected/.test(lower)) {
      error = "GitLab has newer commits. Pull and resolve them before pushing again."
    } else if (/403|permission|protected branch|you are not allowed/.test(lower)) {
      error =
        "GitLab rejected this push (403). Your token may lack write access to this project — check your role, then try again."
    } else if (/401|authentication failed|invalid username or password/.test(lower)) {
      error = "GitLab rejected the token. Sign out of GitLab in Vector, sign in again, then retry."
    } else if (/repository not found|could not read from remote|404/.test(lower)) {
      error = `Project ${pushUrl.replace(/^https?:\/\/gitlab\.com\//, "").replace(/\.git$/, "")} was not found. Check the name and your access.`
    } else {
      error = lastLines(combined, 4) || `git push exited with code ${push.code ?? "unknown"}.`
    }
    return { ok: false, log: logs.join("\n"), error }
  } catch (error) {
    // Never throw out of here — always resolve a result object.
    return { ok: false, log: logs.join("\n"), error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeGitlabPushes.delete(projectPath)
  }
}
