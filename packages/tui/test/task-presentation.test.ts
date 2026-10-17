import { expect, test } from "bun:test"
import type { Task } from "@vectordevai/schema/task"
import { taskDescription, taskProgress } from "../src/routes/session/task-presentation"

const task: Task.Info = {
  id: "child",
  parentSessionID: "parent",
  source: "subagent",
  title: "Check permissions",
  status: "waiting_on_user",
  startedAt: 1,
  elapsedMs: 2_500,
  attempt: 1,
  ownedPaths: ["src/auth"],
  dependsOn: ["explore"],
  resultAvailable: true,
  resultRef: "session:child",
  controls: { inspect: true, message: true, stop: true },
}

test("task summaries name pending attention and preserve unknown usage", () => {
  expect(taskDescription(task)).toBe("Needs you · 3s · usage unavailable · 1 dependency")
  expect(taskDescription(task)).not.toContain("$0")
  expect(taskDescription({ ...task, status: "running", connection: "disconnected" })).toContain(
    "Disconnected (last known: running)",
  )
})

test("external reported cost never implies a known token count", () => {
  expect(taskDescription({ ...task, source: "external", measuredCost: 0.125, costKind: "priced" })).toContain(
    "$0.1250 reported · tokens unavailable",
  )
  expect(taskDescription({ ...task, source: "external", costKind: "plan" })).toContain("covered by plan")
})

test("bounded inspection includes ownership, dependencies, partial output and the result reference", () => {
  const text = taskProgress({
    task,
    steps: [{ tool: "read", text: "src/auth/permissions.ts", status: "completed" }],
    output: "Found an unchecked owner",
    truncated: true,
  })
  expect(text).toContain("Owns: src/auth")
  expect(text).toContain("Depends on: explore")
  expect(text).toContain("read (completed): src/auth/permissions.ts")
  expect(text).toContain("Found an unchecked owner")
  expect(text).toContain("Full result: session:child")
})

test("unpriced steps cannot be presented as a complete zero-dollar bill", () => {
  expect(
    taskDescription({
      ...task,
      usage: {
        cost: 0,
        total: 100,
        toolUses: 1,
        steps: 1,
        unpricedSteps: 1,
        tokens: { input: 80, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }),
  ).toContain("cost partly unknown")
})
