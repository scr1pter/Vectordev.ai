import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type { GithubAccess } from "./github-api"
import { fetchPullRequest, fetchPullRequests, postPullRequestReview, pushedHead } from "./github-pr"

// A small stand-in for api.github.com that answers the calls the Pull Requests panel makes, so the real request,
// pagination and error code runs end to end without a network or a token.
const HEAD = "a".repeat(40)
const requests: { method: string; path: string; body?: Record<string, unknown> }[] = []
const node = (number: number) => ({
  number,
  title: `Change ${number}`,
  author: number === 3 ? null : { login: "mira" },
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  headRefName: `change-${number}`,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  url: `https://github.com/acme/app/pull/${number}`,
  updatedAt: "2026-10-08T10:00:00Z",
  reviewDecision: number === 1 ? "APPROVED" : null,
  headRefOid: HEAD,
  baseRefOid: "b".repeat(40),
  isCrossRepository: false,
})

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" ? undefined : ((await request.json()) as Record<string, unknown>)
    requests.push({ method: request.method, path: url.pathname, body })
    if (request.headers.get("authorization") !== "Bearer test-token")
      return Response.json({ message: "Bad credentials" }, { status: 401 })
    if (url.pathname === "/graphql") {
      const variables = (body?.variables ?? {}) as { after?: string; number?: number; first?: number }
      const query = String(body?.query)
      if (query.includes("pullRequests(")) {
        const page = variables.after ? [3] : [1, 2]
        return Response.json({
          data: {
            repository: {
              pullRequests: {
                nodes: page.slice(0, variables.first).map(node),
                pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : "cursor-1" },
              },
            },
          },
        })
      }
      const files = variables.after
        ? [{ path: "b.ts", additions: 2, deletions: 0 }]
        : [{ path: "a.ts", additions: 8, deletions: 2 }]
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              ...node(variables.number ?? 0),
              body: "Why this change",
              files: {
                nodes: files,
                pageInfo: { hasNextPage: !variables.after, endCursor: variables.after ? null : "f-1" },
              },
              comments: {
                nodes: [{ author: { login: "sam" }, body: "Looks good", createdAt: "2026-10-08T11:00:00Z" }],
              },
            },
          },
        },
      })
    }
    if (url.pathname === "/repos/acme/app/pulls/7" && request.method === "GET")
      return Response.json({ head: { sha: HEAD } })
    if (url.pathname === "/repos/acme/app/pulls/7/reviews") return Response.json({ id: 1 })
    return Response.json({ message: "Not Found" }, { status: 404 })
  },
})
afterAll(() => server.stop(true))

const access: GithubAccess = { token: "test-token", source: "vector", apiUrl: `http://127.0.0.1:${server.port}` }
const repo = { owner: "acme", name: "app" }

describe("pull requests over GitHub's API", () => {
  test("lists pull requests across pages up to the limit, with the fields the panel shows", async () => {
    const all = await fetchPullRequests(access, repo, "open", 100)
    expect(all.map((pr) => pr.number)).toEqual([1, 2, 3])
    expect(all[0]).toMatchObject({ author: "mira", reviewDecision: "APPROVED", headRefOid: HEAD })
    expect(all[1].reviewDecision).toBeUndefined()
    // A deleted account comes back as GitHub's ghost user, not a crash.
    expect(all[2].author).toBe("ghost")
    expect(await fetchPullRequests(access, repo, "open", 1)).toHaveLength(1)
  })

  test("reads one pull request with every page of its files", async () => {
    const pr = await fetchPullRequest(access, repo, 7)
    expect(pr.files.map((file) => file.path)).toEqual(["a.ts", "b.ts"])
    expect(pr.comments).toEqual([{ author: "sam", body: "Looks good", createdAt: "2026-10-08T11:00:00Z" }])
    expect(pr.body).toBe("Why this change")
  })

  test("posts a review pinned to the commit it ran on", async () => {
    requests.length = 0
    await postPullRequestReview(access, repo, 7, { body: "Two findings", event: "request-changes", head: HEAD })
    const posted = requests.find((request) => request.path.endsWith("/reviews"))
    expect(posted?.body).toEqual({ body: "Two findings", event: "REQUEST_CHANGES", commit_id: HEAD })
  })

  test("refuses to post when the pull request moved after the review", async () => {
    requests.length = 0
    const stale = "c".repeat(40)
    await expect(
      postPullRequestReview(access, repo, 7, { body: "LGTM", event: "approve", head: stale }),
    ).rejects.toThrow("changed after the review started")
    expect(requests.some((request) => request.path.endsWith("/reviews"))).toBe(false)
  })

  test("an expired token says to sign in again", async () => {
    await expect(fetchPullRequests({ ...access, token: "revoked" }, repo, "open", 10)).rejects.toThrow(
      "Sign in to GitHub again",
    )
  })
})

describe("pushedHead", () => {
  const repository = async (remotes: Record<string, string>, tracking: string) => {
    const dir = await mkdtemp(join(tmpdir(), "vector-pr-head-"))
    const run = (...args: string[]) =>
      Bun.spawn(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" }).exited
    await run("init", "-q", "-b", "feature")
    await run(
      "-c",
      "user.name=Vector",
      "-c",
      "user.email=vector@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    )
    for (const [name, url] of Object.entries(remotes)) await run("remote", "add", name, url)
    if (tracking) {
      await run("update-ref", `refs/remotes/${tracking}/feature`, "HEAD")
      await run("branch", "--set-upstream-to", `${tracking}/feature`)
    }
    return dir
  }

  test("names the branch as GitHub knows it, with the fork's owner for a fork", async () => {
    const own = await repository({ origin: "https://github.com/acme/app.git" }, "origin")
    const fork = await repository(
      { origin: "git@github.com:me/app.git", upstream: "https://github.com/acme/app.git" },
      "origin",
    )
    expect(await pushedHead(own, repo)).toBe("feature")
    expect(await pushedHead(fork, repo)).toBe("me:feature")
    await Promise.all([rm(own, { recursive: true, force: true }), rm(fork, { recursive: true, force: true })])
  })

  test("asks for a push when the branch is not on GitHub yet", async () => {
    const local = await repository({ origin: "https://github.com/acme/app.git" }, "")
    await expect(pushedHead(local, repo)).rejects.toThrow("Push this branch to GitHub first")
    await rm(local, { recursive: true, force: true })
  })
})
