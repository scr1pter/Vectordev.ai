import { describe, expect, test } from "bun:test"
import { taskBatchEntries, taskItemLabel, taskItemState } from "./task-batch"

describe("taskBatchEntries", () => {
  test("pairs out-of-order updates by index and retains inputs awaiting metadata", () => {
    expect(
      taskBatchEntries(
        { tasks: [{ description: "CSV" }, { description: "JSON" }, { description: "YAML" }] },
        {
          taskBatch: 1,
          tasks: [
            { index: 1, sessionId: "json", status: "error" },
            { index: 0, sessionId: "csv", status: "completed" },
          ],
        },
      ),
    ).toEqual([
      { index: 0, input: { description: "CSV" }, metadata: { index: 0, sessionId: "csv", status: "completed" } },
      { index: 1, input: { description: "JSON" }, metadata: { index: 1, sessionId: "json", status: "error" } },
      { index: 2, input: { description: "YAML" }, metadata: {} },
    ])
  })

  test("retains indexed metadata when input has been trimmed", () => {
    expect(taskBatchEntries(undefined, { taskBatch: 1, tasks: [{ index: 3, sessionId: "child" }] })).toEqual([
      { index: 3, input: {}, metadata: { index: 3, sessionId: "child" } },
    ])
  })

  test("does not choose an arbitrary child from duplicate indexes or malformed rows", () => {
    expect(
      taskBatchEntries(
        { tasks: [null] },
        {
          taskBatch: 1,
          tasks: [
            null,
            "bad",
            [],
            { index: -1 },
            { index: 0.5 },
            { index: "0" },
            { index: Number.NaN },
            { index: Infinity },
            { index: 0, sessionId: "a" },
            { index: 0, sessionId: "b" },
          ],
        },
      ),
    ).toEqual([{ index: 0, input: {}, metadata: {} }])
  })

  test("legacy and malformed non-batches remain on the scalar path", () => {
    for (const value of [undefined, null, [], "bad", { tasks: "bad" }, { description: "CSV" }]) {
      expect(taskBatchEntries(value, { tasks: [{ index: 0, sessionId: "unmarked" }] })).toBeUndefined()
    }
    expect(taskBatchEntries({ tasks: [{}] }, { tasks: [{ index: 0, sessionId: "unmarked" }] })).toEqual([
      { index: 0, input: {}, metadata: {} },
    ])
  })
})

describe("task item presentation", () => {
  test("a completed parent never supplies missing child success", () => {
    expect(taskItemState(undefined, "completed")).toBe("pending")
    expect(taskItemLabel(undefined, "completed")).toBe("Awaiting status")
    expect(taskItemState("pending", "running")).toBe("pending")
    expect(taskItemState("queued", "running")).toBe("pending")
  })

  test("child outcomes and running siblings survive a parent error", () => {
    expect(taskItemState("completed", "error")).toBe("completed")
    expect(taskItemState("running", "error")).toBe("running")
    expect(taskItemState("error", "completed")).toBe("error")
    expect(taskItemState("cancelled", "completed")).toBe("error")
    expect(taskItemState(undefined, "error")).toBe("error")
    expect(
      ["completed", "error", "cancelled", "running", "queued", "pending", undefined].map((status) =>
        taskItemLabel(status, "error"),
      ),
    ).toEqual(["Completed", "Failed", "Stopped", "Running", "Queued", "Pending", "Interrupted"])
  })
})
