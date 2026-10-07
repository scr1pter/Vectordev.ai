import { describe, expect, test } from "bun:test"
import { submitPullRequestReview, type GhRunResult } from "./github-pr"

const HEAD = "a".repeat(40)
const input = { cwd: "/tmp/project", number: 42, head: HEAD, body: "Review summary", event: "approve" as const }
const ok = (stdout = ""): GhRunResult => ({ stdout, stderr: "", failed: false })

describe("reviewed pull request commit", () => {
  test("posts against the reviewed commit after checking the current head", async () => {
    const calls: string[][] = []
    const result = await submitPullRequestReview(input, async (args, options) => {
      expect(options?.cwd).toBe(input.cwd)
      calls.push(args)
      return ok(calls.length === 1 ? `${HEAD}\n` : '{"id":123}')
    })
    expect(result).toEqual({ posted: true })
    expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}/pulls/42", "--method", "GET", "--jq", ".head.sha"])
    expect(calls[1]).toEqual([
      "api",
      "repos/{owner}/{repo}/pulls/42/reviews",
      "--method",
      "POST",
      "-f",
      `commit_id=${HEAD}`,
      "-f",
      "event=APPROVE",
      "-f",
      "body=Review summary",
    ])
  })

  test("refuses a review when another push changed the pull request", async () => {
    const calls: string[][] = []
    await expect(
      submitPullRequestReview(input, async (args) => {
        calls.push(args)
        return ok("b".repeat(40))
      }),
    ).rejects.toThrow("changed after the review started")
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toContain("POST")
  })

  test("does not send a review if the current commit cannot be verified", async () => {
    const calls: string[][] = []
    await expect(
      submitPullRequestReview(input, async (args) => {
        calls.push(args)
        return { stdout: "", stderr: "GitHub is unavailable", failed: true }
      }),
    ).rejects.toThrow("GitHub is unavailable")
    expect(calls).toHaveLength(1)
  })

  test("rejects a missing or branch-shaped reviewed head before calling GitHub", async () => {
    const calls: string[][] = []
    await expect(
      submitPullRequestReview({ ...input, head: "feature" }, async (args) => {
        calls.push(args)
        return ok(HEAD)
      }),
    ).rejects.toThrow("full commit SHA")
    expect(calls).toEqual([])
  })

  test("posts comments and change requests with the same commit binding", async () => {
    for (const event of ["comment", "request-changes"] as const) {
      const calls: string[][] = []
      await submitPullRequestReview({ ...input, event }, async (args) => {
        calls.push(args)
        return ok(HEAD)
      })
      expect(calls[1]).toContain(`commit_id=${HEAD}`)
      expect(calls[1]).toContain(event === "comment" ? "event=COMMENT" : "event=REQUEST_CHANGES")
    }
  })
})
