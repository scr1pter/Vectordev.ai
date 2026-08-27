import { execFile } from "node:child_process"
import { platform } from "node:os"
import { agentEnvironment, resolveAgentPath, shimmedCommand } from "./external-agents"
import { GH_PACKAGE_MANAGERS, ghInstallHint, type GhPackageManager } from "./gh-install"
import {
  requireMergeStrategy,
  requirePullRequestDirectory,
  requirePullRequestLimit,
  requirePullRequestNumber,
  requirePullRequestState,
  requirePullRequestText,
  requireReviewEvent,
} from "./github-pr-input"

// Pull request management through the user's own GitHub CLI. gh already holds
// their credentials and honours their SSO and org policies, so Vector drives it
// rather than asking for another token.

export type GhRunResult = { stdout: string; stderr: string; failed: boolean }

// gh pr diff on a large PR blows past a small buffer and surfaces as a generic
// spawn failure, so give it real headroom. List/view calls are quick; diff and
// review can be slow on big repos.
async function gh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const environment = agentEnvironment()
  const executable = await resolveAgentPath("gh", environment)
  if (!executable) return { stdout: "", stderr: "GitHub CLI was not found.", failed: true }
  const launch = shimmedCommand(executable, args)
  return new Promise<GhRunResult>((resolve) => {
    execFile(
      launch.command,
      launch.args,
      {
        cwd: opts.cwd,
        env: environment,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
      },
      (error, stdout, stderr) =>
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), failed: Boolean(error) }),
    )
  })
}

// Kept for ci-watch's one-line hint. The real answer comes from
// resolveGhInstall below, which only ever names a manager this machine has.
export const GH_INSTALL_COMMAND: Record<string, string> = {
  darwin: "brew install gh",
  win32: "winget install --id GitHub.cli -e",
  linux: "sudo snap install gh",
}

// Looked up through the login-shell PATH for the same reason external agents
// are: a Finder-launched app inherits none of the user's shell setup, so
// Homebrew at /opt/homebrew/bin is invisible without it.
async function availablePackageManagers() {
  const environment = agentEnvironment()
  const found = await Promise.all(
    GH_PACKAGE_MANAGERS.map(
      async (manager) => [manager, Boolean(await resolveAgentPath(manager, environment))] as const,
    ),
  )
  return Object.fromEntries(found) as Partial<Record<GhPackageManager, boolean>>
}

export async function resolveGhInstall() {
  return ghInstallHint(platform(), await availablePackageManagers())
}

export type PullRequestCliStatus = {
  installed: boolean
  authenticated: boolean
  login?: string
  // Absent when nothing on this machine can install gh in one command; the URL
  // is always present so the panel can still offer a way forward.
  installCommand?: string
  installUrl: string
  installDetail: string
  authCommand: string
  detail: string
}

export async function pullRequestCliStatus(): Promise<PullRequestCliStatus> {
  const install = await resolveGhInstall()
  const installCommand = install.command
  const installUrl = install.url
  const installDetail = install.detail
  const authCommand = "gh auth login"
  const version = await gh(["--version"], { timeoutMs: 10_000 })
  if (version.failed) {
    return {
      installed: false,
      authenticated: false,
      installCommand,
      installUrl,
      installDetail,
      authCommand,
      detail: "Install the GitHub CLI to create, review, and merge pull requests from Vector.",
    }
  }
  // gh writes auth status to stderr on older releases and stdout on newer ones.
  const status = await gh(["auth", "status"], { timeoutMs: 10_000 })
  const combined = `${status.stdout}\n${status.stderr}`
  const login = combined.match(/Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/)?.[1]
  return {
    installed: true,
    authenticated: !status.failed && Boolean(login),
    login,
    installCommand,
    installUrl,
    installDetail,
    authCommand,
    detail: status.failed || !login ? "Sign in to GitHub to load pull requests." : `Signed in as ${login}.`,
  }
}

export type PullRequestSummary = {
  number: number
  title: string
  author: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  changedFiles: number
  url: string
  updatedAt: string
  reviewDecision?: string
}

const LIST_FIELDS =
  "number,title,author,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,url,updatedAt,reviewDecision"

function parseJson<T>(raw: string): T | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return undefined
  }
}

type RawPullRequest = Omit<PullRequestSummary, "author"> & { author?: { login?: string } }

function normalize(raw: RawPullRequest): PullRequestSummary {
  return { ...raw, author: raw.author?.login ?? "unknown" }
}

// gh defaults to 30 results and never paginates, so ask for a real limit up
// front rather than silently truncating the user's PR list.
export async function listPullRequests(
  cwd: string,
  options?: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
) {
  const directory = requirePullRequestDirectory(cwd)
  const result = await gh(
    [
      "pr",
      "list",
      "--state",
      requirePullRequestState(options?.state ?? "open"),
      "--limit",
      String(requirePullRequestLimit(options?.limit ?? 100)),
      "--json",
      LIST_FIELDS,
    ],
    { cwd: directory, timeoutMs: 45_000 },
  )
  if (result.failed) throw new Error(result.stderr.trim() || "Could not list pull requests.")
  return (parseJson<RawPullRequest[]>(result.stdout) ?? []).map(normalize)
}

export type PullRequestDetail = PullRequestSummary & {
  body: string
  files: { path: string; additions: number; deletions: number }[]
  comments: { author: string; body: string; createdAt: string }[]
}

export async function viewPullRequest(cwd: string, number: number): Promise<PullRequestDetail> {
  const result = await gh(
    ["pr", "view", String(requirePullRequestNumber(number)), "--json", `${LIST_FIELDS},body,files,comments`],
    {
      cwd: requirePullRequestDirectory(cwd),
      timeoutMs: 45_000,
    },
  )
  if (result.failed) throw new Error(result.stderr.trim() || `Could not load pull request #${number}.`)
  const raw = parseJson<
    RawPullRequest & {
      body?: string
      files?: { path: string; additions: number; deletions: number }[]
      comments?: { author?: { login?: string }; body?: string; createdAt?: string }[]
    }
  >(result.stdout)
  if (!raw) throw new Error(`Could not read pull request #${number}.`)
  return {
    ...normalize(raw),
    body: raw.body ?? "",
    files: raw.files ?? [],
    comments: (raw.comments ?? []).map((comment) => ({
      author: comment.author?.login ?? "unknown",
      body: comment.body ?? "",
      createdAt: comment.createdAt ?? "",
    })),
  }
}

export async function pullRequestDiff(cwd: string, number: number) {
  const result = await gh(["pr", "diff", String(requirePullRequestNumber(number))], {
    cwd: requirePullRequestDirectory(cwd),
    timeoutMs: 90_000,
  })
  if (result.failed) throw new Error(result.stderr.trim() || `Could not load the diff for #${number}.`)
  return result.stdout
}

export async function createPullRequest(input: {
  cwd: string
  title: string
  body: string
  base?: string
  draft?: boolean
}) {
  const args = [
    "pr",
    "create",
    "--title",
    requirePullRequestText(input.title, "Pull request title", 256, false),
    "--body",
    requirePullRequestText(input.body, "Pull request body", 1_000_000),
  ]
  if (input.base) args.push("--base", requirePullRequestText(input.base, "Base branch", 255, false))
  if (input.draft === true) args.push("--draft")
  const result = await gh(args, { cwd: requirePullRequestDirectory(input.cwd), timeoutMs: 90_000 })
  if (result.failed) throw new Error(result.stderr.trim() || "Could not create the pull request.")
  return {
    url:
      result.stdout
        .trim()
        .split(/\s+/)
        .find((token) => token.startsWith("http")) ?? "",
  }
}

// Posting a review is the one action here that is visible to other people, so
// it stays an explicit call the UI only makes after the user confirms.
export async function submitPullRequestReview(input: {
  cwd: string
  number: number
  body: string
  event: "comment" | "approve" | "request-changes"
}) {
  const result = await gh(
    [
      "pr",
      "review",
      String(requirePullRequestNumber(input.number)),
      `--${requireReviewEvent(input.event)}`,
      "--body",
      requirePullRequestText(input.body, "Review body", 1_000_000, false),
    ],
    {
      cwd: requirePullRequestDirectory(input.cwd),
      timeoutMs: 60_000,
    },
  )
  if (result.failed) throw new Error(result.stderr.trim() || "Could not post the review.")
  return { posted: true }
}

export async function mergePullRequest(input: {
  cwd: string
  number: number
  strategy: "merge" | "squash" | "rebase"
}) {
  const result = await gh(
    ["pr", "merge", String(requirePullRequestNumber(input.number)), `--${requireMergeStrategy(input.strategy)}`],
    {
      cwd: requirePullRequestDirectory(input.cwd),
      timeoutMs: 90_000,
    },
  )
  if (result.failed) throw new Error(result.stderr.trim() || "Could not merge the pull request.")
  return { merged: true }
}
