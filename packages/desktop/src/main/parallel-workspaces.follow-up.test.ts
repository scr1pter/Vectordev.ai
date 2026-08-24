import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
const store = new Map<string, Map<string, unknown>>()
// parallel-workspaces pulls in the cloud and publish modules transitively, so
// the stub has to cover every electron export they touch at module load.
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
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))
// drainParallelRunQueue fires synchronously off followUpParallelWorkspace, so
// without this a queued happy-path test would spawn a real CLI.
type StubRunInput = { runtime: string; prompt: string; resumeSessionId?: string }
type StubRunResult = { exitCode: number; summary: string; output: string[]; resumeRejected?: boolean }
const runCalls: StubRunInput[] = []
let runHandler = async (_input: StubRunInput, _index: number): Promise<StubRunResult> => ({
  exitCode: 0,
  summary: "stubbed",
  output: [],
})
mock.module("./external-agents", () => ({
  runExternalCodingAgent: async (input: StubRunInput) => {
    runCalls.push(input)
    return runHandler(input, runCalls.length - 1)
  },
  detectExternalAgents: async () => [],
  openInEditor: async () => ({ ok: true }),
  prepareWorkspace: async () => ({ path: userDataPath, isolation: "copy" }),
}))

const { followUpParallelWorkspace, listParallelWorkspaces, refreshParallelWorkspace, stopParallelWorkspace } =
  await import("./parallel-workspaces")

const engine = { url: "http://127.0.0.1:0", directory: "" } as never

// The user's complaint was that an external agent run dead-ends in a review
// page. followUpParallelWorkspace is the entry point that reopens it, so every
// refusal below is a sentence a user will actually read.
describe("sending a follow-up to an external workspace", () => {
  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "vector-follow-up-"))
    store.clear()
    runCalls.length = 0
    runHandler = async () => ({ exitCode: 0, summary: "stubbed", output: [] })
  })

  afterEach(async () => {
    // A queued turn outlives the test that started it, and would then call
    // updateRecord against a store this teardown has already emptied.
    for (const id of started) await stopParallelWorkspace(id).catch(() => undefined)
    started.length = 0
    await new Promise((resolve) => setTimeout(resolve, 0))
    await rm(userDataPath, { recursive: true, force: true })
  })

  // activeRuns/queuedRuns are module-level and survive beforeEach, so each test
  // gets its own id rather than inheriting the previous test's in-flight run.
  let seq = 0
  const started: string[] = []
  const seed = async (overrides: Record<string, unknown> = {}) => {
    const isolatedPath = join(userDataPath, "iso")
    await mkdir(isolatedPath, { recursive: true })
    seq += 1
    const record = {
      id: `ws-${seq}`,
      name: "Workspace",
      taskPrompt: "original mission",
      runtime: "codex",
      provider: "openai",
      model: "gpt-5",
      sourcePath: userDataPath,
      isolatedPath,
      isolation: "copy",
      status: "needs review",
      progress: 100,
      lastAction: "done",
      createdAt: "2026-08-24T00:00:00.000Z",
      lastActivityAt: "2026-08-24T00:00:00.000Z",
      changedFilesCount: 1,
      riskLevel: "low",
      estimatedCost: "$0.00",
      finalSummary: "did the thing",
      mergeState: "none",
      logs: [],
      terminalOutput: [],
      browserResults: [],
      changedFiles: ["a.ts"],
      diff: "",
      externalSessionId: "sid-1",
      ...overrides,
    }
    store.set("parallel-workspaces-state", new Map([["records", [record]]]))
    return record
  }

  const settle = async (id: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const record = (await listParallelWorkspaces()).find((item) => item.id === id)
      if (record && ["needs review", "complete", "failed", "stopped"].includes(record.status)) return record
    }
    throw new Error("the follow-up turn never settled")
  }

  test("an empty message is refused before anything is queued", async () => {
    const seeded = await seed()
    await expect(followUpParallelWorkspace(seeded.id, engine, "   ")).rejects.toThrow("Type a message")
  })

  test("a missing workspace is refused", async () => {
    await seed()
    await expect(followUpParallelWorkspace("no-such-workspace", engine, "hi")).rejects.toThrow("was not found")
  })

  test("a Vector-runtime workspace is redirected to its own chat session", async () => {
    const seeded = await seed({ runtime: "vector" })
    await expect(followUpParallelWorkspace(seeded.id, engine, "hi")).rejects.toThrow("their own chat session")
  })

  test("a merged workspace cannot be continued", async () => {
    const seeded = await seed({ mergeState: "merged" })
    await expect(followUpParallelWorkspace(seeded.id, engine, "hi")).rejects.toThrow("cannot be continued")
  })

  test("a workspace whose isolated folder is gone is refused rather than silently rebuilt", async () => {
    // ensureParallelWorkspaceIsolation would rebuild it as a fresh copy, which
    // discards exactly the work being followed up on.
    const seeded = await seed({ isolatedPath: join(userDataPath, "vanished") })
    await expect(followUpParallelWorkspace(seeded.id, engine, "hi")).rejects.toThrow("isolated folder is gone")
  })

  test("the message is appended as a user turn and the record is left queued", async () => {
    const seeded = await seed()
    started.push(seeded.id)
    const queued = await followUpParallelWorkspace(seeded.id, engine, "now add a test")
    const userTurns = (queued.turns ?? []).filter((turn) => turn.role === "user")
    expect(userTurns.length).toBe(1)
    expect(userTurns[0]?.text).toBe("now add a test")
    // The id must be registered in queuedRuns before the status write, or this
    // sweep rewrites the record to "failed" on the renderer's next 1.5s poll.
    const listed = await listParallelWorkspaces()
    expect(listed.find((record) => record.id === seeded.id)?.status).not.toBe("failed")
  })

  test("a refresh mid-turn does not flip the record out from under the running agent", async () => {
    const seeded = await seed()
    started.push(seeded.id)
    await followUpParallelWorkspace(seeded.id, engine, "now add a test")
    // The turn has already been picked up by the queue drain, so the status has
    // legitimately advanced. What must NOT happen is a flip to "needs review"
    // under the running agent, which is what the activeRuns/queuedRuns gate
    // prevents.
    const refreshed = await refreshParallelWorkspace(seeded.id)
    expect(refreshed.status).not.toBe("needs review")
  })

  // cursor-agent could not be installed on this machine, so its resume flags are
  // an informed guess. This is the guarantee that makes shipping that guess
  // defensible: a CLI that refuses the flags re-briefs instead of failing.
  test("a refused resume re-briefs the agent instead of reporting a broken run", async () => {
    const seeded = await seed({ runtime: "cursor" })
    started.push(seeded.id)
    runHandler = async (input, index) => {
      if (index === 0 && input.resumeSessionId) {
        return { exitCode: 2, summary: "", output: ["[stderr] error: unexpected argument '--resume'"], resumeRejected: true }
      }
      return { exitCode: 0, summary: "re-briefed and done", output: [] }
    }

    await followUpParallelWorkspace(seeded.id, engine, "now add a test")
    const settled = await settle(seeded.id)

    expect(runCalls.length).toBe(2)
    expect(runCalls[0]?.resumeSessionId).toBe("sid-1")
    // The retry must drop the id, or every later turn pays for the same refusal.
    expect(runCalls[1]?.resumeSessionId).toBeUndefined()
    // ...and must carry the written summary, or the agent redoes the mission.
    expect(runCalls[1]?.prompt).toContain("[vector:continuation]")
    expect(runCalls[1]?.prompt).toContain("now add a test")
    expect(settled.externalSessionId).toBeUndefined()
    // The transcript must stop claiming the agent remembers the conversation.
    const agentTurns = (settled.turns ?? []).filter((turn) => turn.role === "agent")
    expect(agentTurns.at(-1)?.resumed).toBe(false)
  })

  test("a second message while one is in flight is refused instead of being dropped", async () => {
    const seeded = await seed()
    started.push(seeded.id)
    await followUpParallelWorkspace(seeded.id, engine, "first")
    await expect(followUpParallelWorkspace(seeded.id, engine, "second")).rejects.toThrow("still working")
  })
})
