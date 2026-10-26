import { expect, test } from "bun:test"
import { PermissionPolicy } from "../src/permission-policy"

// An edit to a file Vector reads into a prompt asks every time: no saved "Always allow", rule or client auto-accept
// answers it, so `vector run --auto` refuses it too.
test("a change to a prompt source always asks and can never be approved for good", () => {
  expect(PermissionPolicy.PROMPT_SOURCE).toBe("prompt_source")
  expect(PermissionPolicy.requiresApproval(PermissionPolicy.PROMPT_SOURCE, [])).toBe(true)
  expect(PermissionPolicy.requiresApproval(PermissionPolicy.PROMPT_SOURCE, ["*"], ["agents/build.md"])).toBe(true)
  expect(PermissionPolicy.canAutoApprove(PermissionPolicy.PROMPT_SOURCE, ["*"])).toBe(false)
  expect(PermissionPolicy.canAlwaysApprove(PermissionPolicy.PROMPT_SOURCE, ["*"])).toBe(false)
})

test("an ordinary edit is unchanged", () => {
  expect(PermissionPolicy.requiresApproval("edit", ["*"], ["src/foo.ts"])).toBe(false)
  expect(PermissionPolicy.canAutoApprove("edit", ["*"], ["src/foo.ts"])).toBe(true)
  expect(PermissionPolicy.canAlwaysApprove("edit", ["*"], ["src/foo.ts"])).toBe(true)
})

// A command that drops the marker owner-only commands refuse under asks every time, so `--auto` never answers it.
test("a command that drops the agent marker always asks and can never be approved for good", () => {
  expect(
    PermissionPolicy.requiresApproval(PermissionPolicy.AGENT_MARKER, ["*"], ["env -i vector trust prompts approve"]),
  ).toBe(true)
  expect(PermissionPolicy.canAutoApprove(PermissionPolicy.AGENT_MARKER, ["*"])).toBe(false)
  expect(PermissionPolicy.canAlwaysApprove(PermissionPolicy.AGENT_MARKER, ["*"])).toBe(false)
})
