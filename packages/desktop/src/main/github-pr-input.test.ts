import { describe, expect, test } from "bun:test"
import {
  requireMergeStrategy,
  requirePullRequestDirectory,
  requirePullRequestLimit,
  requirePullRequestNumber,
  requirePullRequestState,
  requirePullRequestText,
  requireReviewEvent,
} from "./github-pr-input"

describe("pull request bridge input", () => {
  test("accepts the bounded values emitted by the Vector UI", () => {
    expect(requirePullRequestDirectory("/tmp/project")).toBe("/tmp/project")
    expect(requirePullRequestNumber(42)).toBe(42)
    expect(requirePullRequestState("open")).toBe("open")
    expect(requirePullRequestLimit(100)).toBe(100)
    expect(requireReviewEvent("request-changes")).toBe("request-changes")
    expect(requireMergeStrategy("squash")).toBe("squash")
    expect(requirePullRequestText("Review", "Review body", 100)).toBe("Review")
  })

  test("rejects option-shaped identifiers and unsupported actions", () => {
    expect(() => requirePullRequestNumber("--repo=someone/else" as unknown)).toThrow("positive integer")
    expect(() => requirePullRequestState("--repo=someone/else")).toThrow("Invalid pull request state")
    expect(() => requireReviewEvent("body")).toThrow("Invalid pull request review action")
    expect(() => requireMergeStrategy("delete-branch")).toThrow("Invalid pull request merge strategy")
  })

  test("rejects relative directories and unbounded content", () => {
    expect(() => requirePullRequestDirectory("../other-project")).toThrow("absolute project path")
    expect(() => requirePullRequestLimit(501)).toThrow("between 1 and 500")
    expect(() => requirePullRequestText("", "Title", 256, false)).toThrow("Title is invalid")
    expect(() => requirePullRequestText("x".repeat(257), "Title", 256)).toThrow("Title is invalid")
  })
})
