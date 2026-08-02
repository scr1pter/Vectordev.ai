import { describe, expect, test } from "bun:test"
import { normalizeTaskScope, taskScopeFromSearch, taskScopeId, taskScopeSearch } from "./task-scope"

describe("task scope", () => {
  test("keeps separate tasks in the same project isolated", () => {
    const first = taskScopeId({ projectPath: "/code/vector/", taskId: "task-a" })
    const second = taskScopeId({ projectPath: "/code/vector", taskId: "task-b" })

    expect(first).not.toBe(second)
  })

  test("normalizes project paths before building an identity", () => {
    expect(taskScopeId({ projectPath: "/code/vector/", taskId: "task-a" })).toBe(
      taskScopeId({ projectPath: "/code/vector", taskId: "task-a" }),
    )
  })

  test("round trips full-screen workspace route state", () => {
    const scope = normalizeTaskScope({ projectPath: "/code/Vector App/", taskId: "session-123" })
    expect(taskScopeFromSearch(taskScopeSearch(scope))).toEqual(scope)
  })
})
