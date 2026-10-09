import { describe, expect, test } from "bun:test"
import {
  buildPullRequestCreateInput,
  buildPullRequestMergeInput,
  createPullRequestRequestScope,
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

  test("discards an older selection response that finishes after the newest one in the same repository", async () => {
    const scope = createPullRequestRequestScope(() => ({ path: "/repo/a", revision: 1 }))
    let release = (_value: string) => {}
    let selected = ""
    const first = scope.start()
    const pending = new Promise<string>((resolve) => {
      release = resolve
    }).then((value) => {
      if (first()) selected = value
    })
    const second = scope.start()
    if (second()) selected = "PR 2"
    release("PR 1")
    await pending
    expect(selected).toBe("PR 2")
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  test("invalidates a response when the panel closes or the repository changes and returns", () => {
    let project = { path: "/repo/a", revision: 1 }
    const scope = createPullRequestRequestScope(() => project)
    const closed = scope.start()
    scope.invalidate()
    expect(closed()).toBe(false)

    const changed = scope.start()
    project = { path: "/repo/b", revision: 2 }
    project = { path: "/repo/a", revision: 3 }
    expect(changed()).toBe(false)
  })
})
