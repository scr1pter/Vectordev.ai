import { describe, expect, test } from "bun:test"
import {
  requireMergeStrategy,
  requirePullRequestComments,
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

  describe("line comments", () => {
    const comment = { path: "src/a.ts", line: 9, side: "RIGHT", startLine: 6, body: "This block leaks the handle" }

    test("keeps only the fields GitHub is sent", () => {
      expect(
        requirePullRequestComments([
          { ...comment, extra: "--force" },
          { ...comment, startLine: undefined },
        ]),
      ).toEqual([comment, { ...comment, startLine: undefined }])
      expect(requirePullRequestComments([])).toEqual([])
    })

    test("rejects more comments than one review carries", () => {
      expect(() => requirePullRequestComments(Array.from({ length: 61 }, () => comment))).toThrow("at most 60")
      expect(() => requirePullRequestComments("comments")).toThrow("at most 60")
    })

    test("rejects comments GitHub could not anchor", () => {
      expect(() => requirePullRequestComments([{ ...comment, side: "right" }])).toThrow("side must be LEFT or RIGHT")
      expect(() => requirePullRequestComments([{ ...comment, startLine: 9 }])).toThrow("must start before")
      expect(() => requirePullRequestComments([{ ...comment, startLine: 12 }])).toThrow("must start before")
      expect(() => requirePullRequestComments([{ ...comment, line: 0 }])).toThrow("positive integers")
      expect(() => requirePullRequestComments([{ ...comment, line: 2.5 }])).toThrow("positive integers")
      expect(() => requirePullRequestComments([{ ...comment, line: 10_000_001 }])).toThrow("positive integers")
      expect(() => requirePullRequestComments([{ ...comment, startLine: "6" }])).toThrow("positive integers")
      expect(() => requirePullRequestComments([null])).toThrow("Line comment 1 is invalid")
    })

    test("rejects paths outside the repository and empty bodies", () => {
      expect(() => requirePullRequestComments([{ ...comment, path: "src/\0a.ts" }])).toThrow(
        "relative to the repository",
      )
      expect(() => requirePullRequestComments([{ ...comment, path: "/etc/passwd" }])).toThrow(
        "relative to the repository",
      )
      expect(() => requirePullRequestComments([{ ...comment, path: "" }])).toThrow("relative to the repository")
      expect(() => requirePullRequestComments([{ ...comment, path: "a".repeat(1_025) }])).toThrow(
        "relative to the repository",
      )
      expect(() => requirePullRequestComments([comment, { ...comment, body: "  " }])).toThrow(
        "Line comment 2 body is invalid",
      )
      expect(() => requirePullRequestComments([{ ...comment, body: "x".repeat(65_537) }])).toThrow("body is invalid")
    })
  })
})
