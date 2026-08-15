import { describe, expect, test } from "bun:test"
import { hasActiveVerification, isActiveVerification } from "./session-activity"

describe("session activity", () => {
  test("detects active judge and test subagents", () => {
    expect(
      isActiveVerification({
        type: "tool",
        tool: "task",
        state: { status: "running", input: { subagent_type: "judge" } },
      }),
    ).toBe(true)
    expect(
      isActiveVerification({
        type: "tool",
        tool: "task",
        state: { status: "pending", input: { subagent_type: "test" } },
      }),
    ).toBe(true)
  })

  test("detects active verification commands", () => {
    expect(
      hasActiveVerification([
        { type: "tool", tool: "bash", state: { status: "running", input: { command: "bun typecheck" } } },
      ]),
    ).toBe(true)
    expect(
      hasActiveVerification([
        { type: "tool", tool: "bash", state: { status: "running", input: { command: "pytest tests/unit" } } },
      ]),
    ).toBe(true)
  })

  test("ignores completed checks and ordinary tools", () => {
    expect(
      hasActiveVerification([
        { type: "tool", tool: "bash", state: { status: "completed", input: { command: "bun test" } } },
        { type: "tool", tool: "read", state: { status: "running", input: { path: "src/app.ts" } } },
      ]),
    ).toBe(false)
  })
})
