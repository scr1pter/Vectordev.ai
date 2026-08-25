import { describe, expect, test } from "bun:test"

import {
  githubIssueToWorkItem,
  jiraIssueToWorkItem,
  linearIssueToWorkItem,
  normalizeStatus,
  sortWorkItems,
  workItemPrompt,
  workItemWorkspaceName,
  type WorkItem,
} from "./work-items-model"

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "github:1",
    provider: "github",
    key: "#1",
    title: "Uploads over 2GB fail silently",
    body: "Safari aborts the request and we swallow the error.",
    url: "https://github.com/o/r/issues/1",
    state: "OPEN",
    status: "todo",
    labels: [],
    updatedAt: "2026-08-24T10:00:00.000Z",
    comments: [],
    ...overrides,
  }
}

describe("normalising tracker vocabulary", () => {
  test("each tracker's own words land on one of four states", () => {
    expect(normalizeStatus("Todo")).toBe("todo")
    expect(normalizeStatus("Backlog")).toBe("todo")
    expect(normalizeStatus("In Progress")).toBe("in-progress")
    expect(normalizeStatus("Doing")).toBe("in-progress")
    expect(normalizeStatus("In Review")).toBe("review")
    expect(normalizeStatus("Code Review")).toBe("review")
    expect(normalizeStatus("Done")).toBe("done")
    expect(normalizeStatus("CLOSED")).toBe("done")
    expect(normalizeStatus("Merged")).toBe("done")
  })

  test("review is decided before progress", () => {
    // A tracker that spells it "In Progress - Review" means review; checking
    // progress first would strand it in the wrong column.
    expect(normalizeStatus("In Progress - Review")).toBe("review")
  })

  test("anything unrecognised is todo rather than dropped", () => {
    expect(normalizeStatus("Icebox")).toBe("todo")
    expect(normalizeStatus("")).toBe("todo")
  })
})

describe("normalising each provider", () => {
  test("a GitHub issue keeps its number, labels and comments", () => {
    const work = githubIssueToWorkItem({
      number: 612,
      title: "Fix the flaky upload test",
      body: "It fails about one run in five.",
      url: "https://github.com/o/r/issues/612",
      state: "OPEN",
      updatedAt: "2026-08-24T09:00:00.000Z",
      assignees: [{ login: "krishna" }],
      labels: [{ name: "bug" }, { name: "p2" }],
      comments: [{ author: { login: "sam" }, body: "Only on CI." }],
    })
    expect(work).toMatchObject({ provider: "github", key: "#612", status: "todo", assignee: "krishna" })
    expect(work.labels).toEqual(["bug", "p2"])
    expect(work.comments).toEqual([{ author: "sam", text: "Only on CI." }])
  })

  test("a Linear issue uses its identifier as the key", () => {
    const work = linearIssueToWorkItem({
      id: "abc",
      identifier: "VEC-2481",
      title: "Uploads fail on Safari",
      description: "Large uploads abort.",
      url: "https://linear.app/x/issue/VEC-2481",
      state: { name: "In Progress" },
      assignee: { name: "Krishna" },
      labels: { nodes: [{ name: "bug" }] },
      comments: { nodes: [{ user: { name: "Sam" }, body: "Repros at 2GB." }] },
    })
    expect(work).toMatchObject({ provider: "linear", key: "VEC-2481", status: "in-progress", assignee: "Krishna" })
    expect(work.comments[0]).toEqual({ author: "Sam", text: "Repros at 2GB." })
  })

  test("a Jira issue gets a browse URL built from the site", () => {
    // Jira's REST payload carries an API self link, not a link a person can
    // open, so the browser URL has to be constructed.
    const work = jiraIssueToWorkItem(
      { id: "10042", key: "VEC-7", fields: { summary: "Rate limit the API", status: { name: "In Review" } } },
      "https://acme.atlassian.net/",
    )
    expect(work.url).toBe("https://acme.atlassian.net/browse/VEC-7")
    expect(work).toMatchObject({ provider: "jira", key: "VEC-7", status: "review" })
  })

  test("missing optional fields never throw", () => {
    expect(() => githubIssueToWorkItem({ number: 1, title: "t", url: "u", state: "OPEN" })).not.toThrow()
    expect(() => linearIssueToWorkItem({ id: "a", identifier: "A-1", title: "t", url: "u" })).not.toThrow()
    expect(() => jiraIssueToWorkItem({ id: "1", key: "A-1" }, "https://x.atlassian.net")).not.toThrow()
  })

  test("a very long description is truncated and says so", () => {
    const work = githubIssueToWorkItem({ number: 1, title: "t", url: "u", state: "OPEN", body: "x".repeat(5_000) })
    expect(work.body.length).toBeLessThan(4_200)
    expect(work.body).toContain("truncated by Vector")
  })
})

describe("the brief handed to the agent", () => {
  test("carries the description and the comments, not just the title", () => {
    const prompt = workItemPrompt(
      item({
        key: "VEC-2481",
        provider: "linear",
        labels: ["bug", "p2"],
        comments: [
          { author: "Sam", text: "Only above 2GB." },
          { author: "Ada", text: "Safari only." },
        ],
      }),
    )
    expect(prompt).toContain("VEC-2481")
    expect(prompt).toContain("Linear")
    expect(prompt).toContain("Safari aborts the request")
    expect(prompt).toContain("- Sam: Only above 2GB.")
    expect(prompt).toContain("- Ada: Safari only.")
    expect(prompt).toContain("Labels: bug, p2")
  })

  test("says so plainly when there is nothing but a title", () => {
    const prompt = workItemPrompt(item({ body: "", comments: [] }))
    expect(prompt).toContain("no description beyond its title")
  })

  test("tells the agent to report ambiguity rather than guess", () => {
    expect(workItemPrompt(item())).toContain("say so in your summary instead of guessing")
  })

  test("empty comments are dropped rather than rendered as blank bullets", () => {
    const prompt = workItemPrompt(item({ comments: [{ author: "Sam", text: "   " }] }))
    expect(prompt).not.toContain("- Sam:")
  })
})

describe("presentation", () => {
  test("the workspace name pairs the key with a shortened title", () => {
    expect(workItemWorkspaceName(item({ key: "VEC-1", title: "Short title" }))).toBe("VEC-1 · Short title")
    const long = workItemWorkspaceName(item({ key: "VEC-2", title: "x".repeat(80) }))
    expect(long.length).toBeLessThan(60)
    expect(long).toContain("…")
  })

  test("live work sorts above finished work, newest first inside a group", () => {
    const sorted = sortWorkItems([
      item({ id: "a", status: "done", updatedAt: "2026-08-24T12:00:00.000Z" }),
      item({ id: "b", status: "todo", updatedAt: "2026-08-24T08:00:00.000Z" }),
      item({ id: "c", status: "in-progress", updatedAt: "2026-08-24T09:00:00.000Z" }),
      item({ id: "d", status: "todo", updatedAt: "2026-08-24T11:00:00.000Z" }),
    ])
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "d", "b", "a"])
  })
})
