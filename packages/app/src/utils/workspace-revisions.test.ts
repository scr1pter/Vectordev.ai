import { describe, expect, test } from "bun:test"
import { sameWorkspaceRevisions } from "./workspace-revisions"

const poll = (revisions: Record<string, number | undefined>) =>
  Object.entries(revisions).map(([id, revision]) => ({ id, revision, name: `Agent ${id}` }))

describe("sameWorkspaceRevisions", () => {
  test("only the same records at the same revisions, in the same order, are unchanged", () => {
    expect(sameWorkspaceRevisions(poll({ a: 3, b: 7 }), poll({ a: 3, b: 7 }))).toBe(true)
    expect(sameWorkspaceRevisions(poll({ a: 3, b: 7 }), poll({ a: 4, b: 7 }))).toBe(false)
    expect(sameWorkspaceRevisions(poll({ a: 3, b: 7 }), poll({ b: 7, a: 3 }))).toBe(false)
    expect(sameWorkspaceRevisions(poll({ a: 3, b: 7 }), poll({ a: 3 }))).toBe(false)
    expect(sameWorkspaceRevisions([], [])).toBe(true)
  })

  test("treats a record without a revision as changed", () => {
    expect(sameWorkspaceRevisions(poll({ a: undefined }), poll({ a: undefined }))).toBe(false)
    expect(sameWorkspaceRevisions(poll({ a: 1 }), poll({ a: undefined }))).toBe(false)
  })
})
