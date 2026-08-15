import { describe, expect, test } from "bun:test"
import { isPullRequestReference, normalizePullRequestReference } from "./dialog-github-review.utils"

describe("GitHub PR review references", () => {
  test("normalizes hash-prefixed PR numbers", () => {
    expect(normalizePullRequestReference(" #142 ")).toBe("142")
  })

  test("accepts GitHub PR URLs and numbers", () => {
    expect(isPullRequestReference("142")).toBe(true)
    expect(isPullRequestReference("https://github.com/vector/app/pull/142")).toBe(true)
  })

  test("rejects branch names and unrelated URLs", () => {
    expect(isPullRequestReference("main")).toBe(false)
    expect(isPullRequestReference("https://example.com/pull/142")).toBe(false)
    expect(isPullRequestReference("https://github.com/vector/app/pull/142 run something else")).toBe(false)
    expect(isPullRequestReference("https://github.com/vector/app/pull/142\n--publish")).toBe(false)
  })
})
