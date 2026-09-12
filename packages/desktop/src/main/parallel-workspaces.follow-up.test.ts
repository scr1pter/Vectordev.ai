import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExternalAgentRunResult, RunExternalAgentInput } from "./external-agents"

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
type StubRunInput = Pick<
  RunExternalAgentInput,
  "runtime" | "prompt" | "resumeSessionId" | "onChat" | "onEvent" | "signal"
>
type StubRunResult = {
  exitCode: number
  summary: string
  output: string[]
  actualCost?: string
  resumeRejected?: boolean
}
const runCalls: StubRunInput[] = []
let runHandler = async (_input: StubRunInput, _index: number): Promise<StubRunResult> => ({
  exitCode: 0,
  summary: "stubbed",
  output: [],
})
const dependencies = {
  runExternalCodingAgent: async (input: RunExternalAgentInput): Promise<ExternalAgentRunResult> => {
    runCalls.push(input)
    return runHandler(input, runCalls.length - 1)
  },
}

const {
  createParallelWorkspace,
  followUpParallelWorkspace,
  listParallelWorkspaces,
  refreshParallelWorkspace,
  runParallelWorkspace,
  stopParallelWorkspace,
} = await import("./parallel-workspaces")

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

  test("external chat is persisted separately from raw diagnostics and survives completion", async () => {
    const seeded = await seed()
    runHandler = async (input) => {
      input.onEvent?.({ stream: "stdout", text: '{"type":"private_protocol"}' })
      input.onEvent?.({ stream: "activity", text: "command_execution: PRIVATE COMMAND" })
      input.onChat?.({
        messages: [{ id: "answer", text: "I checked the project." }],
        activity: [{ id: "tool", label: "Reading project", kind: "tool", state: "running" }],
      })
      return { exitCode: 0, summary: "I checked the project.", output: [] }
    }
    started.push(seeded.id)
    await followUpParallelWorkspace(seeded.id, engine, "check it", dependencies)
    const record = await settle(seeded.id)
    const answer = record.turns?.findLast((turn) => turn.role === "agent")
    expect(answer?.messages).toEqual([{ id: "answer", text: "I checked the project." }])
    expect(answer?.activity?.[0]?.state).toBe("done")
    expect(answer?.streamTail).toBeUndefined()
    expect(JSON.stringify(answer)).not.toContain("PRIVATE")
    expect(record.terminalOutput).toContain('{"type":"private_protocol"}')
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

  test("closed workspace history drops review-only payloads before the next store write", async () => {
    const seeded = await seed({
      status: "discarded",
      mergeState: "discarded",
      changedFilesCount: 2,
      changedFiles: ["large-a.ts", "large-b.ts"],
      diff: "large diff\n".repeat(10_000),
      baselineHashes: { "large-a.ts": "a", "large-b.ts": "b" },
    })

    const listed = listParallelWorkspaces().find((record) => record.id === seeded.id)!
    expect(listed.changedFilesCount).toBe(2)
    expect(listed.changedFiles).toEqual([])
    expect(listed.diff).toBe("")
    expect(listed.baselineHashes).toBeUndefined()

    const persisted = store.get("parallel-workspaces-state")?.get("records") as (typeof listed)[]
    expect(persisted[0]?.diff).toBe("")
    expect(persisted[0]?.baselineHashes).toBeUndefined()
  })

  test("an open review keeps the payload required for selective merge", async () => {
    const seeded = await seed({
      diff: "diff --git a/a.ts b/a.ts",
      baselineHashes: { "a.ts": "hash" },
    })

    const listed = listParallelWorkspaces().find((record) => record.id === seeded.id)!
    expect(listed.changedFiles).toEqual(["a.ts"])
    expect(listed.diff).toContain("diff --git")
    expect(listed.baselineHashes).toEqual({ "a.ts": "hash" })
  })

  test("a new copy workspace publishes its baseline before the renderer can refresh it", async () => {
    const sourcePath = join(userDataPath, "project")
    await mkdir(sourcePath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Read only\n", "utf8")

    const created = await createParallelWorkspace({
      name: "Read only",
      taskPrompt: "Read README.md and report its title.",
      runtime: "codex",
      parentSessionId: "session-1",
      sourcePath,
    })

    expect(created.isolation).toBe("copy")
    expect(Object.keys(created.baselineHashes ?? {})).toContain("README.md")
    const refreshed = await refreshParallelWorkspace(created.id)
    expect(refreshed.changedFiles).toEqual([])
    expect(refreshed.diff).toBe("")
    expect(refreshed.riskLevel).toBe("low")
  })

  test("a task can hold more than sixteen active agents", async () => {
    const sourcePath = join(userDataPath, "project")
    await mkdir(sourcePath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Many\n", "utf8")
    const created = []
    for (let index = 0; index < 17; index++) {
      created.push(
        await createParallelWorkspace({
          name: `Agent ${index + 1}`,
          taskPrompt: "Read README.md.",
          runtime: "codex",
          parentSessionId: "session-many",
          sourcePath,
        }),
      )
    }
    expect(created).toHaveLength(17)
  })

  test("seventeen runs on an open pool all start at once instead of queueing", async () => {
    const sourcePath = join(userDataPath, "project")
    await mkdir(sourcePath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Many\n", "utf8")
    // Never finishes by itself, so every run still holds its slot when the
    // records are read. Resolving on abort lets the teardown's stop release it.
    runHandler = (input) =>
      new Promise((resolve) =>
        input.signal?.addEventListener("abort", () => resolve({ exitCode: 130, summary: "Stopped.", output: [] }), {
          once: true,
        }),
      )
    const ids: string[] = []
    for (let index = 0; index < 17; index++) {
      const created = await createParallelWorkspace({
        name: `Agent ${index + 1}`,
        taskPrompt: "Read README.md.",
        runtime: "codex",
        parentSessionId: "session-pool",
        sourcePath,
      })
      ids.push(created.id)
      started.push(created.id)
    }
    // No concurrency argument: the path swarms and follow-ups take, so this checks
    // the default pool rather than one sized for the test.
    for (const id of ids) await runParallelWorkspace(id, engine, undefined, dependencies)
    for (let attempt = 0; attempt < 500 && runCalls.length < ids.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const records = listParallelWorkspaces().filter((record) => ids.includes(record.id))
    expect(records).toHaveLength(17)
    expect(
      records.filter((record) => record.lastAction === "Queued for an agent slot").map((record) => record.name),
    ).toEqual([])
    expect(
      records
        .filter((record) => !["planning", "editing", "running commands", "testing"].includes(record.status))
        .map((record) => `${record.name}: ${record.status}`),
    ).toEqual([])
    // Every runner was called and none has returned: all seventeen at once.
    expect(runCalls).toHaveLength(17)
  }, 60_000)

  test("an external turn shows its chat while it runs and keeps it when it settles", async () => {
    const seeded = await seed()
    started.push(seeded.id)
    let release = () => {}
    const released = new Promise<void>((resolve) => (release = resolve))
    const chat = {
      messages: [{ id: "answer", text: "Editing a.ts now." }],
      activity: [
        { id: "codex-turn", label: "Thinking", kind: "thinking" as const, state: "done" as const },
        { id: "patch", label: "Updating files", kind: "tool" as const, state: "running" as const, files: ["src/a.ts"] },
      ],
    }
    runHandler = async (input) => {
      input.onChat?.(chat)
      await released
      return { exitCode: 0, summary: "Editing a.ts now.", output: [] }
    }
    await followUpParallelWorkspace(seeded.id, engine, "edit a.ts", dependencies)

    let live: ReturnType<typeof listParallelWorkspaces>[number] | undefined
    for (let attempt = 0; attempt < 100 && !live; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const record = listParallelWorkspaces().find((item) => item.id === seeded.id)
      if (record?.turns?.findLast((turn) => turn.role === "agent")?.messages?.length) live = record
    }
    const running = live?.turns?.findLast((turn) => turn.role === "agent")
    expect(running?.state).toBe("running")
    expect(running?.messages).toEqual(chat.messages)
    // The workspace list is what the renderer receives over IPC, so the edited
    // path has to be on the persisted record, not only in the runner's chat.
    expect(running?.activity?.[1]?.files).toEqual(["src/a.ts"])
    // The header names the step in progress, not the thinking that ended.
    expect(live?.lastAction).toBe("Updating files")

    release()
    const settled = await settle(seeded.id)
    const done = settled.turns?.findLast((turn) => turn.role === "agent")
    expect(done?.state).toBe("done")
    expect(done?.messages).toEqual(chat.messages)
    expect(done?.activity?.[1]).toMatchObject({ state: "done", files: ["src/a.ts"] })
  })

  test("a legacy copy without a baseline never reports the whole tree as newly added", async () => {
    const sourcePath = join(userDataPath, "source")
    const isolatedPath = join(userDataPath, "legacy-copy")
    await mkdir(sourcePath, { recursive: true })
    await mkdir(isolatedPath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Same\n", "utf8")
    await writeFile(join(isolatedPath, "README.md"), "# Same\n", "utf8")
    const seeded = await seed({ sourcePath, isolatedPath, baselineHashes: undefined, changedFiles: [], diff: "" })

    const refreshed = await refreshParallelWorkspace(seeded.id)
    expect(refreshed.changedFiles).toEqual([])
    expect(refreshed.diff).toBe("")
    expect(refreshed.riskLevel).toBe("low")
  })

  test("a clean refresh clears a stale high-risk classification", async () => {
    const sourcePath = join(userDataPath, "clean-source")
    const isolatedPath = join(userDataPath, "clean-copy")
    const contents = "# Unchanged\n"
    await mkdir(sourcePath, { recursive: true })
    await mkdir(isolatedPath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), contents, "utf8")
    await writeFile(join(isolatedPath, "README.md"), contents, "utf8")
    const seeded = await seed({
      sourcePath,
      isolatedPath,
      baselineHashes: { "README.md": createHash("sha256").update(contents).digest("hex") },
      changedFiles: ["README.md"],
      changedFilesCount: 1,
      diff: "stale false diff",
      riskLevel: "high",
    })

    const refreshed = await refreshParallelWorkspace(seeded.id)
    expect(refreshed.changedFiles).toEqual([])
    expect(refreshed.changedFilesCount).toBe(0)
    expect(refreshed.diff).toBe("")
    expect(refreshed.riskLevel).toBe("low")
  })

  test("a read-only initial external run skips guardrails and still records cost and outcome", async () => {
    const sourcePath = join(userDataPath, "read-only-project")
    await mkdir(sourcePath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Vector\n", "utf8")
    runHandler = async () => ({ exitCode: 0, summary: "Document title: Vector", actualCost: "$0.0123", output: [] })
    const created = await createParallelWorkspace({
      name: "Read README",
      taskPrompt: "Inspect README.md only and report its title. Do not edit files.",
      runtime: "codex",
      parentSessionId: "session-1",
      sourcePath,
    })
    started.push(created.id)

    await runParallelWorkspace(created.id, engine, undefined, dependencies)
    const settled = await settle(created.id)

    expect(settled.status).toBe("complete")
    expect(settled.changedFilesCount).toBe(0)
    expect(settled.riskLevel).toBe("low")
    expect(settled.actualCost).toBe("$0.0123")
    expect(settled.finalSummary).toBe("Document title: Vector")
    expect(settled.validationReport).toBeUndefined()
    expect(settled.logs[0]).toContain("deterministic checks were skipped")
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
    const queued = await followUpParallelWorkspace(seeded.id, engine, "now add a test", dependencies)
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
    await followUpParallelWorkspace(seeded.id, engine, "now add a test", dependencies)
    // The turn has already been picked up by the queue drain, so the status has
    // legitimately advanced. What must NOT happen is a flip to "needs review"
    // under the running agent, which is what the activeRuns/queuedRuns gate
    // prevents.
    const refreshed = await refreshParallelWorkspace(seeded.id)
    expect(refreshed.status).not.toBe("needs review")
  })

  test("every external runtime turn is told to load repository-authored Vector rules", async () => {
    const seeded = await seed()
    started.push(seeded.id)
    await followUpParallelWorkspace(seeded.id, engine, "now add a test", dependencies)
    await settle(seeded.id)

    expect(runCalls[0]?.prompt).toContain("Read .vector/RULES.md when present before making changes")
    expect(runCalls[0]?.prompt).toContain("teammate-authored content outside Vector's managed rules block")
  })

  // A future CLI can still retire a verified resume flag. The compatibility
  // guarantee is that a refusal re-briefs instead of failing.
  test("a refused resume re-briefs the agent instead of reporting a broken run", async () => {
    const seeded = await seed({ runtime: "cursor" })
    started.push(seeded.id)
    runHandler = async (input, index) => {
      if (index === 0 && input.resumeSessionId) {
        return {
          exitCode: 2,
          summary: "",
          output: ["[stderr] error: unexpected argument '--resume'"],
          resumeRejected: true,
        }
      }
      return { exitCode: 0, summary: "re-briefed and done", output: [] }
    }

    await followUpParallelWorkspace(seeded.id, engine, "now add a test", dependencies)
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
    await followUpParallelWorkspace(seeded.id, engine, "first", dependencies)
    await expect(followUpParallelWorkspace(seeded.id, engine, "second")).rejects.toThrow("still working")
  })
})
