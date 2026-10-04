import { describe, expect, test } from "bun:test"
import { filterGithubRepos, relativeTime } from "./github-connect-domain"

describe("relativeTime", () => {
  const now = Date.parse("2026-10-04T12:00:00Z")
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const minute = 60_000

  test("rounds to the largest sensible unit", () => {
    expect(relativeTime(ago(10_000), now)).toBe("just now")
    expect(relativeTime(ago(5 * minute), now)).toBe("5m ago")
    expect(relativeTime(ago(3 * 60 * minute), now)).toBe("3h ago")
    expect(relativeTime(ago(4 * 24 * 60 * minute), now)).toBe("4d ago")
    expect(relativeTime(ago(90 * 24 * 60 * minute), now)).toBe("3mo ago")
    expect(relativeTime(ago(800 * 24 * 60 * minute), now)).toBe("2y ago")
  })

  test("ignores missing and invalid timestamps", () => {
    expect(relativeTime(undefined, now)).toBeUndefined()
    expect(relativeTime("not a date", now)).toBeUndefined()
  })
})

describe("filterGithubRepos", () => {
  const repos = [{ fullName: "octocat/Hello-World" }, { fullName: "vector/app" }, { fullName: "Vector/desktop" }]

  test("matches the full name case-insensitively", () => {
    expect(filterGithubRepos(repos, "  VECTOR ")).toEqual([{ fullName: "vector/app" }, { fullName: "Vector/desktop" }])
    expect(filterGithubRepos(repos, "hello")).toEqual([{ fullName: "octocat/Hello-World" }])
    expect(filterGithubRepos(repos, "missing")).toEqual([])
  })

  test("an empty query keeps every repository", () => {
    expect(filterGithubRepos(repos, "")).toBe(repos)
  })
})
