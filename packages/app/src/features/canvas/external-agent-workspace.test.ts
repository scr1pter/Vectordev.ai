import { describe, expect, test } from "bun:test"
import {
  canvasExternalWorkspaceDraft,
  reopenableCanvasExternalWorkspaces,
  type CanvasExternalWorkspaceRecord,
} from "./external-agent-workspace"

function workspace(input: Partial<CanvasExternalWorkspaceRecord> & Pick<CanvasExternalWorkspaceRecord, "id">) {
  return {
    id: input.id,
    name: input.name ?? input.id,
    taskPrompt: input.taskPrompt ?? "Implement the task",
    runtime: input.runtime ?? "claude-code",
    status: input.status ?? "needs review",
    lastAction: input.lastAction,
    lastActivityAt: input.lastActivityAt ?? "2026-08-30T12:00:00.000Z",
    changedFilesCount: input.changedFilesCount ?? 1,
    mergeState: input.mergeState ?? "none",
  }
}

describe("Canvas external-agent workspace handoff", () => {
  test("hands a trimmed mission to the canonical workspace composer", () => {
    expect(canvasExternalWorkspaceDraft("codex", "  Fix the flaky tests  ")).toEqual({
      runtime: "codex",
      taskPrompt: "Fix the flaky tests",
      name: "Fix the flaky tests",
    })
    expect(canvasExternalWorkspaceDraft("cursor", "   ")).toBeUndefined()
  })

  test("keeps generated workspace names bounded", () => {
    const taskPrompt = "a".repeat(80)
    expect(canvasExternalWorkspaceDraft("claude-code", taskPrompt)?.name).toHaveLength(54)
  })

  test("reopens only live canonical records for the selected runtime", () => {
    const records = [
      workspace({ id: "older", lastActivityAt: "2026-08-30T10:00:00.000Z" }),
      workspace({ id: "newer", status: "running commands", lastActivityAt: "2026-08-30T11:00:00.000Z" }),
      workspace({ id: "vector", runtime: "vector" }),
      workspace({ id: "merged", status: "merged", mergeState: "merged" }),
      workspace({ id: "discarded", status: "discarded", mergeState: "discarded" }),
    ]

    expect(reopenableCanvasExternalWorkspaces(records, "claude-code").map((record) => record.id)).toEqual([
      "newer",
      "older",
    ])
    expect(records.map((record) => record.id)).toEqual(["older", "newer", "vector", "merged", "discarded"])
  })
})
