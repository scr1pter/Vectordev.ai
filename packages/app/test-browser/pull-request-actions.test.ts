import { describe, expect, test } from "bun:test"
import {
  buildPullRequestCreateInput,
  buildPullRequestMergeInput,
  pullRequestErrorMessage,
  pullRequestMergeAction,
  pullRequestProjectIsCurrent,
} from "@/features/pull-requests/pull-request-actions"

describe("pull request project actions", () => {
  test("builds the exact create and merge bridge payloads", () => {
    expect(
      buildPullRequestCreateInput({
        cwd: "/repo/vector",
        title: "  Release PR  ",
        body: "Ready to ship",
        base: " main ",
        draft: true,
      }),
    ).toEqual({
      cwd: "/repo/vector",
      title: "Release PR",
      body: "Ready to ship",
      base: "main",
      draft: true,
    })
    expect(buildPullRequestMergeInput({ cwd: "/repo/vector", number: 7, strategy: "rebase" })).toEqual({
      cwd: "/repo/vector",
      number: 7,
      strategy: "rebase",
    })
  })

  test("requires one confirmation step before a merge action", () => {
    let confirming = false
    let merges = 0
    const click = () => {
      if (pullRequestMergeAction(confirming) === "confirm") {
        confirming = true
        return
      }
      merges++
    }

    click()
    expect(confirming).toBe(true)
    expect(merges).toBe(0)
    click()
    expect(merges).toBe(1)
  })

  test("rejects stale repository responses and preserves useful errors", () => {
    const request = { path: "/repo/a", revision: 1 }
    expect(pullRequestProjectIsCurrent(request, { path: "/repo/a", revision: 1 })).toBe(true)
    expect(pullRequestProjectIsCurrent(request, { path: "/repo/b", revision: 2 })).toBe(false)
    expect(pullRequestErrorMessage(new Error("gh status unavailable"))).toBe("gh status unavailable")
  })
})
