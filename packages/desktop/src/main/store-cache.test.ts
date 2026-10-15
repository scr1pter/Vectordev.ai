import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
// electron-store reads and parses its whole file on every get. Each fake store counts those reads, and getStore
// returns the same instance for a name until the test replaces it, as the real store cache does.
const stores = new Map<string, { reads: number; values: Map<string, unknown>; instance: object }>()
const electronMock = {
  app: { isPackaged: false, getPath: () => userDataPath, getVersion: () => "test", on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => undefined, openPath: async () => "" },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: class {
    static isSupported() {
      return false
    }
  },
  dialog: {},
  clipboard: {},
  systemPreferences: {},
  utilityProcess: {},
  net: {},
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => (stores.get(name) ?? fakeStore(name)).instance,
  removeStoreFileIfEmpty: () => undefined,
}))

function fakeStore(name: string, values = new Map<string, unknown>()) {
  const entry = { reads: 0, values, instance: {} }
  entry.instance = {
    get: (key: string) => {
      entry.reads += 1
      return structuredClone(entry.values.get(key))
    },
    set: (key: string, value: unknown) => entry.values.set(key, structuredClone(value)),
    delete: (key: string) => entry.values.delete(key),
    path: join(userDataPath, `${name}.json`),
  }
  stores.set(name, entry)
  return entry
}

const { getParallelWorkspace, listParallelWorkspaces, recordParallelWorkspacePreview, refreshParallelWorkspace } =
  await import("./parallel-workspaces")
const { listSwarmRuns } = await import("./swarm-orchestrator")
const { createBackgroundTask, listBackgroundTasks, updateBackgroundTask } = await import("./background-tasks")

const STORE = "parallel-workspaces-state"

function record(id: string, sourcePath: string) {
  return {
    id,
    revision: 3,
    name: id,
    taskPrompt: "mission",
    runtime: "vector",
    provider: "openai",
    model: "gpt-6.1",
    sourcePath,
    parentSessionId: "ses_task",
    // No checkout on disk, so a refresh returns the record without diffing.
    isolatedPath: join(userDataPath, "missing", id),
    isolation: "copy",
    status: "needs review",
    progress: 100,
    lastAction: "done",
    createdAt: "2026-10-15T00:00:00.000Z",
    lastActivityAt: "2026-10-15T00:00:00.000Z",
    changedFilesCount: 0,
    riskLevel: "low",
    estimatedCost: "$0.00",
    mergeState: "none",
    logs: [],
    terminalOutput: [],
    browserResults: [],
    changedFiles: [],
    diff: "",
  }
}

function swarm(workerID: string) {
  return {
    id: "swarm-1",
    name: "Swarm",
    objective: "mission",
    sourcePath: userDataPath,
    parentSessionId: "ses_task",
    strategy: "balanced",
    maxAgents: 2,
    maxConcurrency: 2,
    modelPool: [],
    plannerProvider: "openai",
    plannerModel: "gpt-6.1",
    status: "complete",
    currentStep: "done",
    progress: 100,
    planSummary: "",
    tasks: [{ id: "task-1", workspaceId: workerID, status: "complete" }],
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    changedFiles: [],
    diff: "",
    riskLevel: "low",
    summary: "",
    logs: [],
  }
}

// A restart opens the store file again, which the fake models as a new store instance holding these records.
function open(records: unknown[], name = STORE) {
  return fakeStore(name, new Map([["records", records]]))
}

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), "vector-workspace-store-"))
  stores.clear()
})

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true })
})

test("a minute of task-route polling reads each store file once", async () => {
  const workspaces = open([record("ws-listed", userDataPath), record("ws-worker", join(userDataPath, "elsewhere"))])
  const runs = fakeStore("swarm-orchestrator-state", new Map([["runs", [swarm("ws-worker")]]]))
  const tasks = fakeStore("background-tasks")
  createBackgroundTask({
    kind: "parallel-workspace",
    projectPath: userDataPath,
    taskId: "ses_task",
    name: "Background task",
  })
  const scope = { sourcePath: userDataPath, parentSessionId: "ses_task" }
  // The layout polls every 1.5 s: the scoped workspaces, the swarm runs, a refresh of the swarm worker the list
  // leaves out, then the background tasks.
  for (let poll = 0; poll < 40; poll++) {
    expect(listParallelWorkspaces(scope)).toHaveLength(1)
    expect(listSwarmRuns(scope)).toHaveLength(1)
    expect((await refreshParallelWorkspace("ws-worker")).revision).toBe(3)
    expect(listBackgroundTasks({ projectPath: userDataPath, taskId: "ses_task" })).toHaveLength(1)
  }
  expect([workspaces.reads, runs.reads, tasks.reads]).toEqual([1, 1, 1])
})

test("writes are visible to the next read without reading the file again", () => {
  const entry = open([record("ws-1", userDataPath)])
  expect(getParallelWorkspace("ws-1")?.previewUrl).toBeUndefined()
  recordParallelWorkspacePreview("ws-1", "https://preview.example.test")
  const listed = listParallelWorkspaces()
  expect(listed[0]).toMatchObject({ id: "ws-1", revision: 4, previewUrl: "https://preview.example.test" })
  expect(entry.reads).toBe(1)
  // What the next process reads back is the same record.
  expect((entry.values.get("records") as { previewUrl?: string; revision: number }[])[0]).toMatchObject({
    revision: 4,
    previewUrl: "https://preview.example.test",
  })
})

test("a caller replacing entries in its list does not change what the next caller reads", () => {
  open([record("ws-1", userDataPath)])
  const first = listParallelWorkspaces()
  first.splice(0, 1)
  expect(listParallelWorkspaces().map((item) => item.id)).toEqual(["ws-1"])
})

test("a store opened again is read again", () => {
  open([record("ws-old", userDataPath)])
  expect(listParallelWorkspaces().map((item) => item.id)).toEqual(["ws-old"])
  const reopened = open([record("ws-new", userDataPath)])
  expect(listParallelWorkspaces().map((item) => item.id)).toEqual(["ws-new"])
  expect(reopened.reads).toBe(1)
})

test("a background task update is visible to the next list without reading the file again", () => {
  const tasks = fakeStore("background-tasks")
  const task = createBackgroundTask({
    kind: "parallel-workspace",
    projectPath: userDataPath,
    taskId: "ses_task",
    name: "Task",
  })
  updateBackgroundTask(task.id, { status: "running", currentStep: "Editing" })
  expect(listBackgroundTasks({ projectPath: userDataPath, taskId: "ses_task" })[0]).toMatchObject({
    status: "running",
    currentStep: "Editing",
  })
  expect(tasks.reads).toBe(1)
})
