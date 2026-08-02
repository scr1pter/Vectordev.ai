import { describe, expect, test } from "bun:test"
import { planModeRouteScope, shouldResetPlanMode } from "./plan-mode-scope"

describe("plan mode task scope", () => {
  test("resets when the active session changes", () => {
    expect(
      shouldResetPlanMode(
        planModeRouteScope("/project/session/task-a", ""),
        planModeRouteScope("/project/session/task-b", ""),
      ),
    ).toBe(true)
  })

  test("stays enabled when the same task opens a fullscreen workspace", () => {
    expect(
      shouldResetPlanMode(
        planModeRouteScope("/project/session/task-a", ""),
        planModeRouteScope("/parallel-workspaces", "?project=%2Frepo&parentSession=task-a"),
      ),
    ).toBe(false)
  })

  test("carries the choice into the session created by the first prompt", () => {
    expect(
      shouldResetPlanMode(
        planModeRouteScope("/project/session", ""),
        planModeRouteScope("/project/session/task-a", ""),
      ),
    ).toBe(false)
  })
})
