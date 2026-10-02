import { describe, expect, test } from "bun:test"
import { branchPickerKeys, branchPickerRows, createRowKey, isManagedWorkspaceBranch } from "./branch-picker-rows"

const branches = [
  { name: "feature/login", current: false },
  { name: "main", current: true },
  { name: "agent/refactor", current: false, checkedOutElsewhere: "/repo/.worktrees/refactor" },
  { name: "Feature/Logout", current: false },
]

describe("branchPickerRows", () => {
  test("lists every branch with the current one first and no create row for an empty search", () => {
    const rows = branchPickerRows(branches, "  ")
    expect(rows.branches.map((branch) => branch.name)).toEqual([
      "main",
      "feature/login",
      "agent/refactor",
      "Feature/Logout",
    ])
    expect(rows.create).toBeUndefined()
  })

  test("filters case-insensitively and offers to create the typed name", () => {
    const rows = branchPickerRows(branches, "feature/log")
    expect(rows.branches.map((branch) => branch.name)).toEqual(["feature/login", "Feature/Logout"])
    expect(rows.create).toBe("feature/log")
  })

  test("does not offer to create a branch that already exists", () => {
    expect(branchPickerRows(branches, "main").create).toBeUndefined()
    expect(branchPickerRows(branches, " feature/login ").create).toBeUndefined()
  })

  test("turns whitespace in a new name into dashes", () => {
    const rows = branchPickerRows(branches, "fix the  header")
    expect(rows.branches).toEqual([])
    expect(rows.create).toBe("fix-the-header")
  })

  test("is case-sensitive about existing names, like git", () => {
    expect(branchPickerRows(branches, "MAIN").create).toBe("MAIN")
  })
})

describe("branchPickerKeys", () => {
  const idle = { busy: false, managed: false }

  test("skips the current branch and branches checked out elsewhere", () => {
    expect(branchPickerKeys(branchPickerRows(branches, ""), idle)).toEqual(["feature/login", "Feature/Logout"])
  })

  test("ends with the create row when there is one", () => {
    expect(branchPickerKeys(branchPickerRows(branches, "log"), idle)).toEqual([
      "feature/login",
      "Feature/Logout",
      createRowKey,
    ])
  })

  test("has nothing to pick while an agent is running", () => {
    expect(branchPickerKeys(branchPickerRows(branches, "new"), { busy: true, managed: false })).toEqual([])
  })

  test("only offers the create row in a managed agent workspace", () => {
    expect(branchPickerKeys(branchPickerRows(branches, ""), { busy: false, managed: true })).toEqual([])
    expect(branchPickerKeys(branchPickerRows(branches, "log"), { busy: false, managed: true })).toEqual([createRowKey])
    expect(branchPickerKeys(branchPickerRows(branches, "log"), { busy: true, managed: true })).toEqual([])
  })
})

describe("isManagedWorkspaceBranch", () => {
  test("matches the desktop's parallel workspace branches only", () => {
    expect(isManagedWorkspaceBranch("vector-parallel/fix-header-1a2b3c4d")).toBe(true)
    expect(isManagedWorkspaceBranch("main")).toBe(false)
    expect(isManagedWorkspaceBranch("feature/vector-parallel/x")).toBe(false)
  })
})
