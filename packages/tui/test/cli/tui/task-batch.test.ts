import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@vectordevai/sdk/v2"
import { canBackgroundTask, liveBackgroundTasks } from "../../../src/routes/session"

function task(input: Record<string, unknown>, metadata: Record<string, unknown>): ToolPart {
  return {
    id: "part_task",
    sessionID: "ses_parent",
    messageID: "msg_parent",
    callID: "call_task",
    type: "tool",
    tool: "task",
    state: { status: "running", input, metadata, time: { start: 1 } },
  }
}

describe("Task background affordance", () => {
  test("Stop all retains indexed background children alongside scalar tasks", () => {
    const entries = [
      { index: 0, status: "running", sessionId: "ses_batch", background: true, startedAt: 10 },
      { index: 1, status: "completed", sessionId: "ses_done", background: true },
      { index: 2, status: "running", sessionId: "ses_foreground" },
      { index: 3, status: "queued", sessionId: "ses_queued", background: true },
    ]
    expect(
      liveBackgroundTasks([
        task({}, { taskBatch: 1, tasks: entries }),
        task({}, { sessionId: "ses_scalar", status: "running", background: true }),
        task({}, { sessionId: "ses_batch", status: "running", background: true }),
      ]),
    ).toEqual(["ses_batch", "ses_queued", "ses_scalar"])
    expect(liveBackgroundTasks([task({}, { taskBatch: 1, tasks: entries })], (item) => item.startedAt !== 10)).toEqual([
      "ses_queued",
    ])
  })

  test("preserves scalar foreground/background behavior", () => {
    expect(canBackgroundTask(task({ description: "Inspect" }, { sessionId: "ses_child" }))).toBe(true)
    expect(canBackgroundTask(task({ description: "Inspect" }, { sessionId: "ses_child", background: true }))).toBe(
      false,
    )
  })

  test("does not offer multi-item promotion before any child launches", () => {
    expect(canBackgroundTask(task({ tasks: [{ description: "CSV" }, { description: "JSON" }] }, {}))).toBe(false)
  })

  test("does not offer multi-item promotion with trimmed input or a completed sibling", () => {
    expect(
      canBackgroundTask(
        task(
          {},
          {
            taskBatch: 1,
            tasks: [
              { index: 0, status: "completed", sessionId: "ses_csv" },
              { index: 1, status: "running", sessionId: "ses_json" },
            ],
          },
        ),
      ),
    ).toBe(false)
  })

  test("retains promotion for a running one-item array and removes it after promotion", () => {
    const input = { tasks: [{ description: "CSV" }] }
    const item = { index: 0, status: "running", sessionId: "ses_csv" }
    expect(canBackgroundTask(task(input, { taskBatch: 1, tasks: [item] }))).toBe(true)
    expect(canBackgroundTask(task(input, { taskBatch: 1, tasks: [{ ...item, background: true }] }))).toBe(false)
  })

  test("does not treat unlaunched or settled one-item work as active", () => {
    for (const status of ["pending", "queued", "completed", "error", "cancelled"]) {
      expect(canBackgroundTask(task({ tasks: [{}] }, { taskBatch: 1, tasks: [{ index: 0, status }] }))).toBe(false)
    }
  })

  test("refuses ambiguous or sparse metadata and terminal enclosing calls", () => {
    expect(canBackgroundTask(task({}, { taskBatch: 1, tasks: [{ index: 2, status: "running" }] }))).toBe(false)
    expect(
      canBackgroundTask(
        task(
          { tasks: [{}] },
          {
            taskBatch: 1,
            tasks: [
              { index: 0, status: "running" },
              { index: 0, status: "running" },
            ],
          },
        ),
      ),
    ).toBe(false)
    const part = task({ tasks: [{}] }, { taskBatch: 1, tasks: [{ index: 0, status: "running" }] })
    part.state = {
      status: "error",
      input: part.state.input,
      metadata: part.state.status === "running" ? part.state.metadata : undefined,
      error: "Stopped",
      time: { start: 1, end: 2 },
    }
    expect(canBackgroundTask(part)).toBe(false)
  })
})
