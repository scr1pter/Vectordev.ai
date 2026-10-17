import { beforeEach, describe, expect, mock, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"

// electron-store reads and parses the whole file on every get and rewrites it on every set. This stand-in round-trips
// through JSON the same way and counts the writes.
const store = new Map<string, Map<string, string>>()
const writes = { count: 0 }
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => {
        const value = bucket.get(key)
        return value === undefined ? undefined : JSON.parse(value)
      },
      set: (key: string, value: unknown) => {
        writes.count += 1
        bucket.set(key, JSON.stringify(value))
      },
      delete: (key: string) => bucket.delete(key),
      path: join(tmpdir(), `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { createBackgroundTask, listBackgroundTasks } = await import("./background-tasks")

beforeEach(() => {
  store.clear()
  writes.count = 0
})

describe("listBackgroundTasks", () => {
  test("a minute of polling an unchanged list never rewrites the store", () => {
    createBackgroundTask({
      kind: "agent",
      projectPath: "/repo",
      taskId: "ses_1",
      name: "Map the auth flow",
      status: "running",
    })
    expect(writes.count).toBe(1)

    // The app polls every 1.5 s on a task route.
    for (let poll = 0; poll < 40; poll++) {
      const tasks = listBackgroundTasks({ projectPath: "/repo", taskId: "ses_1" })
      expect(tasks.map((task) => [task.name, task.status])).toEqual([["Map the auth flow", "running"]])
    }
    expect(writes.count).toBe(1)
  })

  test("a run left running by an earlier process is marked interrupted and saved once", () => {
    store.set(
      "background-tasks",
      new Map([
        [
          "records",
          JSON.stringify([
            {
              id: "task_1",
              kind: "agent",
              projectPath: "/repo",
              taskId: "ses_1",
              name: "Map the auth flow",
              prompt: "",
              provider: "openai",
              model: "gpt-6.1",
              status: "running",
              progress: 40,
              currentStep: "Reading",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              changedFilesCount: 0,
              terminalActive: false,
              browserActive: false,
              costEstimate: "Estimate unavailable",
              logs: [],
              actions: [],
            },
          ]),
        ],
      ]),
    )

    expect(listBackgroundTasks({ projectPath: "/repo", taskId: "ses_1" })[0]?.status).toBe("interrupted")
    expect(writes.count).toBe(1)
    expect(listBackgroundTasks({ projectPath: "/repo", taskId: "ses_1" })[0]?.status).toBe("interrupted")
    expect(writes.count).toBe(1)
  })
  test("restart settles queued and blocked tasks even when the stored clock is ahead", () => {
    const created = createBackgroundTask({
      kind: "agent",
      projectPath: "/repo",
      taskId: "ses_1",
      name: "waiting",
      status: "queued",
    })
    for (const status of ["queued", "waiting", "needs_input"] as const) {
      store
        .get("background-tasks")!
        .set(
          "records",
          JSON.stringify([
            {
              ...created,
              id: `task-${status}`,
              status,
              processID: "previous-process",
              updatedAt: "2099-01-01T00:00:00.000Z",
            },
          ]),
        )
      const settled = listBackgroundTasks({ projectPath: "/repo", taskId: "ses_1" })[0]!
      expect(settled.status).toBe("interrupted")
      expect(settled.completedAt).toBeDefined()
    }
  })
})
