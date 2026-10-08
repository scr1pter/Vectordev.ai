import { execFile } from "node:child_process"
import { platform } from "node:os"
import { agentEnvironment, refreshAgentEnvironment, resolveAgentPath, shimmedCommand } from "./external-agents"
import { GH_PACKAGE_MANAGERS, ghInstallHint, ghInstallWarning, type GhPackageManager } from "./gh-install"
import {
  requireMergeStrategy,
  requirePullRequestDirectory,
  requirePullRequestHead,
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
// review can be slow on big repos. Every gh call goes through here, so each one
// finds gh the way detection did, through the login-shell PATH.
export async function gh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
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

export async function pullRequestCliStatus(options: { refresh?: boolean } = {}): Promise<PullRequestCliStatus> {
  // "Check again" after installing gh: the PATH from launch cannot know about it.
  if (options.refresh) refreshAgentEnvironment()
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
  // It also exits 1 when any other account or host fails to authenticate, so
  // the github.com sign-in line decides, not the exit code.
  const status = await gh(["auth", "status"], { timeoutMs: 10_000 })
  const combined = `${status.stdout}\n${status.stderr}`
  const login = combined.match(/Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/)?.[1]
  const warning = ghInstallWarning(await resolveAgentPath("gh", agentEnvironment()))
  const signedIn = login ? `Signed in as ${login}.` : "Sign in to GitHub to load pull requests."
  return {
    installed: true,
    authenticated: Boolean(login),
    login,
    installCommand,
    installUrl,
    installDetail,
    authCommand,
    detail: warning ? `${signedIn} ${warning}` : signedIn,
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

const LEGACY_LIST_FIELDS =
  "number,title,author,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,url,updatedAt,reviewDecision"
// The SHAs and the fork flag let a review tell whether the user's checkout is this pull request.
const LIST_FIELDS = `${LEGACY_LIST_FIELDS},headRefOid,baseRefOid,isCrossRepository`

// gh rejects the whole call when it does not know one field ("Unknown JSON field"), and older releases lack
// baseRefOid, so retry with the fields every release has rather than losing the pull request list.
async function ghJson(
  args: (fields: string) => string[],
  extra: string,
  opts: { cwd?: string; timeoutMs?: number },
): Promise<GhRunResult> {
  const result = await gh(args(LIST_FIELDS + extra), opts)
  if (!result.failed || !/unknown json field/i.test(result.stderr)) return result
  return gh(args(LEGACY_LIST_FIELDS + extra), opts)
}

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
  const state = requirePullRequestState(options?.state ?? "open")
  const limit = String(requirePullRequestLimit(options?.limit ?? 100))
  const result = await ghJson((fields) => ["pr", "list", "--state", state, "--limit", limit, "--json", fields], "", {
    cwd: directory,
    timeoutMs: 45_000,
  })
  if (result.failed) throw new Error(result.stderr.trim() || "Could not list pull requests.")
  return (parseJson<RawPullRequest[]>(result.stdout) ?? []).map(normalize)
}

export type PullRequestDetail = PullRequestSummary & {
  body: string
  files: { path: string; additions: number; deletions: number }[]
  comments: { author: string; body: string; createdAt: string }[]
  // Absent on gh releases that predate them.
  headRefOid?: string
  baseRefOid?: string
  isCrossRepository?: boolean
}

export async function viewPullRequest(cwd: string, number: number): Promise<PullRequestDetail> {
  const pr = String(requirePullRequestNumber(number))
  const result = await ghJson((fields) => ["pr", "view", pr, "--json", fields], ",body,files,comments", {
    cwd: requirePullRequestDirectory(cwd),
    timeoutMs: 45_000,
  })
  if (result.failed) throw new Error(result.stderr.trim() || `Could not load pull request #${number}.`)
  const raw = parseJson<
    RawPullRequest & {
      body?: string
      files?: { path: string; additions: number; deletions: number }[]
      comments?: { author?: { login?: string }; body?: string; createdAt?: string }[]
      headRefOid?: string
      baseRefOid?: string
      isCrossRepository?: boolean
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
    headRefOid: raw.headRefOid,
    baseRefOid: raw.baseRefOid,
    isCrossRepository: raw.isCrossRepository,
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
export async function submitPullRequestReview(
  input: {
    cwd: string
    number: number
    head: string
    body: string
    event: "comment" | "approve" | "request-changes"
  },
  run: typeof gh = gh,
) {
  const cwd = requirePullRequestDirectory(input.cwd)
  const number = requirePullRequestNumber(input.number)
  const head = requirePullRequestHead(input.head)
  const event = requireReviewEvent(input.event).toUpperCase().replaceAll("-", "_")
  const body = requirePullRequestText(input.body, "Review body", 1_000_000, false)
  const endpoint = `repos/{owner}/{repo}/pulls/${number}`
  const current = await run(["api", endpoint, "--method", "GET", "--jq", ".head.sha"], { cwd })
  if (current.failed) throw new Error(current.stderr.trim() || "Could not verify the pull request's current commit.")
  if (requirePullRequestHead(current.stdout.trim()) !== head)
    throw new Error(
      "This pull request changed after the review started. Reload it and run Review with Vector again before posting.",
    )

  // The API records the exact commit reviewed, even if another push lands after the check above.
  const result = await run(
    [
      "api",
      `${endpoint}/reviews`,
      "--method",
      "POST",
      "-f",
      `commit_id=${head}`,
      "-f",
      `event=${event}`,
      "-f",
      `body=${body}`,
    ],
    { cwd, timeoutMs: 60_000 },
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
