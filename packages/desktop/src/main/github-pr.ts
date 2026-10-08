import {
  git,
  gitRemotes,
  githubFetch,
  githubGraphql,
  githubJson,
  GithubRequestError,
  parseGithubRemote,
  pickBaseRemote,
  readTail,
  type GithubAccess,
  type GithubRepoRef,
} from "./github-api"
import { githubSignInConfigured, resolveGithubAccess } from "./github-access"
import {
  requireMergeStrategy,
  requirePullRequestComments,
  requirePullRequestDirectory,
  requirePullRequestHead,
  requirePullRequestLimit,
  requirePullRequestNumber,
  requirePullRequestState,
  requirePullRequestText,
  requireReviewEvent,
} from "./github-pr-input"
import { cleanLogLine, failedStepLog, MAX_LOG_BYTES } from "./ci-watch"
import { redactText } from "./security-redaction"

// Pull requests through GitHub's API with the user's GitHub sign-in in Vector. Nothing has to be installed: the
// token is Vector's own device-flow sign-in, or an existing GitHub CLI login for someone who already has one.

export type PullRequestAccessStatus = {
  authenticated: boolean
  // Whether this build of Vector can sign in to GitHub at all.
  configured: boolean
  login?: string
  source?: GithubAccess["source"]
  detail: string
}

export async function pullRequestAccessStatus(): Promise<PullRequestAccessStatus> {
  const configured = await githubSignInConfigured()
  const access = await resolveGithubAccess()
  if (!access) {
    return { authenticated: false, configured, detail: "Sign in to GitHub to load pull requests." }
  }
  const user = await githubJson<{ login?: string }>(access, "/user", { timeoutMs: 15_000 }).then(
    (value) => ({ login: value.login, error: undefined }),
    (error: unknown) => ({ login: undefined, error }),
  )
  // A revoked or expired token needs a new sign-in; anything else (offline, rate limit) is reported by the
  // calls that follow rather than sending a signed-in user back to the sign-in screen.
  if (user.error instanceof GithubRequestError && user.error.status === 401) {
    return { authenticated: false, configured, source: access.source, detail: user.error.message }
  }
  const login = user.login
  return {
    authenticated: true,
    configured,
    login,
    source: access.source,
    detail: login ? `Signed in to GitHub as ${login}.` : "Signed in to GitHub.",
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
  // The SHAs and the fork flag let a review tell whether the user's checkout is this pull request.
  headRefOid?: string
  baseRefOid?: string
  isCrossRepository?: boolean
}

export type PullRequestDetail = PullRequestSummary & {
  body: string
  files: { path: string; additions: number; deletions: number }[]
  comments: { author: string; body: string; createdAt: string }[]
}

const SUMMARY_FIELDS = `number title author { login } state isDraft baseRefName headRefName additions deletions
  changedFiles url updatedAt reviewDecision headRefOid baseRefOid isCrossRepository`

type RawPullRequest = Omit<PullRequestSummary, "author" | "reviewDecision"> & {
  author?: { login?: string } | null
  reviewDecision?: string | null
}

export function toPullRequestSummary(raw: RawPullRequest): PullRequestSummary {
  return {
    ...raw,
    // A deleted account shows as GitHub's "ghost" user.
    author: raw.author?.login ?? "ghost",
    reviewDecision: raw.reviewDecision ?? undefined,
  }
}

// The same states the GitHub CLI offers, where "closed" includes merged pull requests.
const STATES = {
  open: ["OPEN"],
  closed: ["CLOSED", "MERGED"],
  merged: ["MERGED"],
  all: ["OPEN", "CLOSED", "MERGED"],
} as const

export async function listPullRequests(
  cwd: string,
  options?: { state?: "open" | "closed" | "merged" | "all"; limit?: number },
) {
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequests(
    access,
    repo,
    requirePullRequestState(options?.state ?? "open"),
    requirePullRequestLimit(options?.limit ?? 100),
  )
}

export async function fetchPullRequests(
  access: GithubAccess,
  repo: GithubRepoRef,
  state: keyof typeof STATES,
  limit: number,
) {
  const query = `query($owner: String!, $name: String!, $states: [PullRequestState!], $first: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: $states, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes { ${SUMMARY_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`
  const collected: PullRequestSummary[] = []
  let after: string | undefined
  while (collected.length < limit) {
    const data = await githubGraphql<{
      repository: {
        pullRequests: { nodes: RawPullRequest[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }
      } | null
    }>(access, query, {
      owner: repo.owner,
      name: repo.name,
      states: STATES[state],
      first: Math.min(100, limit - collected.length),
      after,
    })
    const page = data.repository?.pullRequests
    if (!page) throw new Error(`GitHub couldn't find ${repo.owner}/${repo.name}, or this account can't see it.`)
    collected.push(...page.nodes.map(toPullRequestSummary))
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break
    after = page.pageInfo.endCursor
  }
  return collected
}

export async function viewPullRequest(cwd: string, number: number): Promise<PullRequestDetail> {
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequest(access, repo, requirePullRequestNumber(number))
}

// GitHub lists at most 3,000 files for a pull request; the newest 100 comments are what a reviewer reads.
const MAX_FILE_PAGES = 30

export async function fetchPullRequest(access: GithubAccess, repo: GithubRepoRef, number: number) {
  const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        ${SUMMARY_FIELDS} body
        files(first: 100, after: $after) {
          nodes { path additions deletions }
          pageInfo { hasNextPage endCursor }
        }
        comments(last: 100) { nodes { author { login } body createdAt } }
      }
    }
  }`
  type Page = {
    repository: {
      pullRequest:
        | (RawPullRequest & {
            body?: string
            files: {
              nodes: { path: string; additions: number; deletions: number }[]
              pageInfo: { hasNextPage: boolean; endCursor?: string }
            }
            comments: { nodes: { author?: { login?: string } | null; body?: string; createdAt?: string }[] }
          })
        | null
    } | null
  }
  const first = await githubGraphql<Page>(access, query, { owner: repo.owner, name: repo.name, number })
  const raw = first.repository?.pullRequest
  if (!raw) throw new Error(`GitHub couldn't find pull request #${number} in ${repo.owner}/${repo.name}.`)
  const files = [...raw.files.nodes]
  let pageInfo = raw.files.pageInfo
  for (let page = 1; page < MAX_FILE_PAGES && pageInfo.hasNextPage && pageInfo.endCursor; page += 1) {
    const next = await githubGraphql<Page>(access, query, {
      owner: repo.owner,
      name: repo.name,
      number,
      after: pageInfo.endCursor,
    })
    const more = next.repository?.pullRequest?.files
    if (!more) break
    files.push(...more.nodes)
    pageInfo = more.pageInfo
  }
  return {
    ...toPullRequestSummary(raw),
    body: raw.body ?? "",
    files,
    comments: raw.comments.nodes.map((comment) => ({
      author: comment.author?.login ?? "ghost",
      body: comment.body ?? "",
      createdAt: comment.createdAt ?? "",
    })),
  } satisfies PullRequestDetail
}

// With the commit the panel last saw, a diff of anything newer is refused: the review reads, anchors and posts
// against that one commit, so it must not review a later push under its name.
export async function pullRequestDiff(cwd: string, number: number, head?: string) {
  const expected = head === undefined ? undefined : requirePullRequestHead(head)
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequestDiff(access, repo, requirePullRequestNumber(number), expected)
}

export async function fetchPullRequestDiff(access: GithubAccess, repo: GithubRepoRef, number: number, head?: string) {
  const response = await githubFetch(access, `${repoPath(repo)}/pulls/${number}`, {
    accept: "application/vnd.github.diff",
    timeoutMs: 90_000,
  }).catch((error: unknown) => {
    // GitHub refuses to render one diff past 300 files or 20,000 lines.
    if (error instanceof GithubRequestError && (error.status === 406 || error.status === 422)) {
      throw new Error(`Pull request #${number} is too large for GitHub to return as one diff. ${error.message}`)
    }
    throw error
  })
  const diff = await response.text()
  // GitHub always renders the newest commit, so a head that still matches after the read is the commit this diff is.
  if (head && (await currentHead(access, repo, number)) !== head) {
    throw new Error("This pull request changed while Vector was reading it. Run Review with Vector again.")
  }
  return diff
}

export async function createPullRequest(input: {
  cwd: string
  title: string
  body: string
  base?: string
  draft?: boolean
}) {
  const cwd = requirePullRequestDirectory(input.cwd)
  const title = requirePullRequestText(input.title, "Pull request title", 256, false)
  const body = requirePullRequestText(input.body, "Pull request body", 1_000_000)
  const { access, repo } = await pullRequestContext(cwd)
  const head = await pushedHead(cwd, repo)
  const base = input.base
    ? requirePullRequestText(input.base, "Base branch", 255, false)
    : (await githubJson<{ default_branch: string }>(access, repoPath(repo))).default_branch
  const created = await githubJson<{ html_url?: string }>(access, `${repoPath(repo)}/pulls`, {
    method: "POST",
    body: { title, body, head, base, draft: input.draft === true },
    timeoutMs: 60_000,
  })
  return { url: created.html_url ?? "" }
}

// A comment on one line of the diff, or on the lines startLine through line. side is the diff column the lines
// are counted in: LEFT for the base commit's lines, RIGHT for the head commit's.
export type PullRequestReviewComment = {
  path: string
  line: number
  side: "LEFT" | "RIGHT"
  startLine?: number
  body: string
}

// Posting a review is the one action here other people see, so the UI only makes this call after the user
// confirms. With the commit the review was run on, GitHub records that exact commit, and the post is refused if
// the pull request has moved since.
export async function submitPullRequestReview(input: {
  cwd: string
  number: number
  head?: string
  body: string
  event: "comment" | "approve" | "request-changes"
  comments?: PullRequestReviewComment[]
  // Posted instead of body, without line comments, if GitHub refuses the comments.
  fallbackBody?: string
}) {
  const number = requirePullRequestNumber(input.number)
  const event = requireReviewEvent(input.event)
  const body = requirePullRequestText(input.body, "Review body", 1_000_000, false)
  const head = input.head === undefined ? undefined : requirePullRequestHead(input.head)
  const comments = input.comments === undefined ? undefined : requirePullRequestComments(input.comments)
  const fallbackBody =
    input.fallbackBody === undefined
      ? undefined
      : requirePullRequestText(input.fallbackBody, "Review fallback body", 1_000_000)
  const { access, repo } = await pullRequestContext(requirePullRequestDirectory(input.cwd))
  return postPullRequestReview(access, repo, number, { body, event, head, comments, fallbackBody })
}

export async function postPullRequestReview(
  access: GithubAccess,
  repo: GithubRepoRef,
  number: number,
  review: {
    body: string
    event: "comment" | "approve" | "request-changes"
    head?: string
    comments?: PullRequestReviewComment[]
    fallbackBody?: string
  },
) {
  const head = review.head
  if (head && (await currentHead(access, repo, number)) !== head) {
    throw new Error("This pull request changed after the review started. Run Review with Vector again before posting.")
  }
  // Line numbers belong to one commit's diff, so line comments are only sent pinned to the commit they were read on.
  const comments = (head ? (review.comments ?? []) : []).map((comment) => ({
    path: comment.path,
    line: comment.line,
    side: comment.side,
    body: comment.body,
    ...(comment.startLine !== undefined && comment.startLine < comment.line
      ? { start_line: comment.startLine, start_side: comment.side }
      : {}),
  }))
  const post = (body: string, lineComments: typeof comments) =>
    githubJson(access, `${repoPath(repo)}/pulls/${number}/reviews`, {
      method: "POST",
      body: {
        body,
        event: review.event.toUpperCase().replaceAll("-", "_"),
        ...(head ? { commit_id: head } : {}),
        ...(lineComments.length ? { comments: lineComments } : {}),
      },
      timeoutMs: 60_000,
    })
  // GitHub refuses the whole review when any one comment's line is outside the diff, so it is posted once more
  // without line comments, under a body that lists every finding instead.
  const inline = await post(review.body, comments)
    .then(() => comments.length)
    .catch((error: unknown) => {
      if (error instanceof GithubRequestError && error.status === 422 && comments.length) {
        return post(review.fallbackBody ?? review.body, []).then(() => 0)
      }
      throw error
    })
  return { posted: true, inline }
}

export type PullRequestChecks = {
  head: string
  // conclusion is "" while a check is still running.
  runs: { name: string; status: string; conclusion: string; url: string }[]
  // The failing step's log of the first few failed GitHub Actions jobs. step and excerpt are "" when GitHub
  // returned no log for the job.
  failures: { name: string; step: string; excerpt: string }[]
}

// The CI results of the commit a review runs on, so a reviewer reads what already failed alongside the diff.
export async function pullRequestChecks(cwd: string, number: number, head: string) {
  requirePullRequestNumber(number)
  const commit = requirePullRequestHead(head)
  const { access, repo } = await pullRequestContext(cwd)
  return fetchPullRequestChecks(access, repo, commit)
}

// Each failure downloads the tail of a job log, so only the first few are read.
const MAX_FAILURE_LOGS = 3
const MAX_FAILURE_EXCERPT = 4_000
// A job that timed out leaves the step it was running cancelled rather than failed.
const FAILED_STEP_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled"])

export async function fetchPullRequestChecks(
  access: GithubAccess,
  repo: GithubRepoRef,
  head: string,
): Promise<PullRequestChecks> {
  const checks = await githubJson<{ check_runs?: RawCheckRun[] }>(
    access,
    `${repoPath(repo)}/commits/${head}/check-runs?per_page=100`,
    { timeoutMs: 45_000 },
  ).catch((error: unknown) => {
    // GitHub answers 404 for a commit it has not seen, which has no checks yet.
    if (error instanceof GithubRequestError && error.status === 404) return { check_runs: [] }
    throw error
  })
  const runs = checks.check_runs ?? []
  return {
    head,
    runs: runs.map((run) => ({
      name: run.name ?? "",
      status: run.status ?? "",
      conclusion: run.conclusion ?? "",
      url: run.html_url ?? "",
    })),
    failures: await Promise.all(
      runs
        .filter(
          (run) =>
            (run.conclusion === "failure" || run.conclusion === "timed_out") && run.app?.slug === "github-actions",
        )
        .slice(0, MAX_FAILURE_LOGS)
        .map((run) => checkFailure(access, repo, run)),
    ),
  }
}

// GitHub's REST shape of a check run.
type RawCheckRun = {
  id?: number
  name?: string
  status?: string | null
  conclusion?: string | null
  html_url?: string | null
  app?: { slug?: string } | null
}

// A GitHub Actions check run's id is its job's id, which names the job's steps and its log. A job whose log GitHub
// has expired, or never wrote, still lists as a failure, just without an excerpt.
async function checkFailure(access: GithubAccess, repo: GithubRepoRef, run: RawCheckRun) {
  const path = `${repoPath(repo)}/actions/jobs/${run.id}`
  const name = run.name ?? ""
  const loaded = await Promise.all([
    githubJson<{ name?: string; steps?: { name?: string; conclusion?: string | null }[] }>(access, path, {
      timeoutMs: 45_000,
    }),
    // GitHub answers with a redirect to a short-lived download URL, which fetch follows.
    githubFetch(access, `${path}/logs`, { timeoutMs: 120_000 }).then((response) => readTail(response, MAX_LOG_BYTES)),
  ]).catch(() => undefined)
  if (!loaded) return { name, step: "", excerpt: "" }
  const [job, tail] = loaded
  // failedStepLog labels each line "<job>\t<step>\t" for parseFailureLog; the excerpt is the bare log text.
  const text = failedStepLog(tail.text, job)
    .map((line) => cleanLogLine(line.split("\t").slice(2).join("\t")))
    .join("\n")
  return {
    name,
    step: job.steps?.find((step) => FAILED_STEP_CONCLUSIONS.has(step.conclusion ?? ""))?.name ?? "",
    // The end of a step holds the error. Redaction runs on a window a little wider than the excerpt rather than
    // the whole step, which can be megabytes, and the result is cut again since redacting can lengthen a line.
    excerpt: redactText(text.slice(-2 * MAX_FAILURE_EXCERPT)).slice(-MAX_FAILURE_EXCERPT),
  }
}

// With the commit the user last saw, GitHub refuses the merge if anything was pushed since, so a commit nobody
// looked at is never merged by this button.
export async function mergePullRequest(input: {
  cwd: string
  number: number
  strategy: "merge" | "squash" | "rebase"
  head?: string
}) {
  const number = requirePullRequestNumber(input.number)
  const strategy = requireMergeStrategy(input.strategy)
  const head = input.head === undefined ? undefined : requirePullRequestHead(input.head)
  const { access, repo } = await pullRequestContext(requirePullRequestDirectory(input.cwd))
  return putPullRequestMerge(access, repo, number, { strategy, head })
}

export async function putPullRequestMerge(
  access: GithubAccess,
  repo: GithubRepoRef,
  number: number,
  merge: { strategy: "merge" | "squash" | "rebase"; head?: string },
) {
  await githubJson(access, `${repoPath(repo)}/pulls/${number}/merge`, {
    method: "PUT",
    body: { merge_method: merge.strategy, ...(merge.head ? { sha: merge.head } : {}) },
    timeoutMs: 90_000,
  }).catch((error: unknown) => {
    if (error instanceof GithubRequestError && error.status === 409 && merge.head) {
      throw new Error("New commits were pushed to this pull request. Look them over, then merge again.")
    }
    throw error
  })
  return { merged: true }
}

async function currentHead(access: GithubAccess, repo: GithubRepoRef, number: number) {
  const pull = await githubJson<{ head?: { sha?: string } }>(access, `${repoPath(repo)}/pulls/${number}`)
  return pull.head?.sha?.toLowerCase()
}

async function pullRequestContext(cwd: string) {
  const directory = requirePullRequestDirectory(cwd)
  const access = await resolveGithubAccess()
  if (!access) throw new Error("Sign in to GitHub to work with pull requests.")
  const remote = pickBaseRemote(await gitRemotes(directory))
  if (!remote) {
    throw new Error(
      "This project has no GitHub remote. Add one with: git remote add origin https://github.com/<owner>/<repo>.git",
    )
  }
  return { access, repo: remote.repo }
}

// The branch GitHub knows this checkout by. A pull request from a fork names its owner, as "owner:branch".
export async function pushedHead(cwd: string, base: GithubRepoRef) {
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd)
  const tracking = upstream.failed ? "" : upstream.stdout.trim()
  const slash = tracking.indexOf("/")
  if (slash < 1) throw new Error("Push this branch to GitHub first, then create the pull request.")
  const remoteName = tracking.slice(0, slash)
  const branch = tracking.slice(slash + 1)
  const url = await git(["remote", "get-url", remoteName], cwd)
  const pushed = parseGithubRemote(url.stdout)
  if (url.failed || !pushed) throw new Error(`The branch tracks ${remoteName}, which is not a GitHub repository.`)
  return pushed.owner.toLowerCase() === base.owner.toLowerCase() ? branch : `${pushed.owner}:${branch}`
}

function repoPath(repo: GithubRepoRef) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}
