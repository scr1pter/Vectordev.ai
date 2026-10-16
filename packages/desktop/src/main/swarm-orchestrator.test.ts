import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParallelWorkspaceRecord } from "./parallel-workspaces"
import type { SwarmRunRecord } from "./swarm-orchestrator"

let directory = ""
const stores = new Map<string, Map<string, unknown>>()
let onWrite = (_name: string, _key: string, _value: unknown) => {}
const electron = {
  app: { isPackaged: false, getPath: () => directory, getVersion: () => "test", on: () => undefined },
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
mock.module("electron", () => ({ default: electron, ...electron }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)!
    return {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value)
        onWrite(name, key, value)
      },
      delete: (key: string) => store.delete(key),
      path: join(directory, `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const { discardSwarmRun, getSwarmRun, listSwarmRuns, resumeSwarmRun, stopSwarmRun } = await import(
  "./swarm-orchestrator"
)
const { createParallelWorkspace, getParallelWorkspace, mergeParallelWorkspace, refreshParallelWorkspace } = await import(
  "./parallel-workspaces"
)
const inspectTask = {
  id: "inspect",
  title: "Inspect the project",
  prompt: "Read the project",
  role: "explore",
  dependsOn: [],
  fileHints: [],
  provider: "test",
  model: "test",
  status: "planned",
  lastAction: "Ready",
  changedFilesCount: 0,
  riskLevel: "low",
  summary: "",
} satisfies SwarmRunRecord["tasks"][number]

describe("swarm lifecycle", () => {
  let server: ReturnType<typeof Bun.serve>
  let prompted = Promise.withResolvers<void>()
  // A test can answer engine requests itself; anything it returns undefined for gets the planner defaults below.
  let route: (url: URL, request: Request) => Response | Promise<Response> | undefined = () => undefined
  const requests: string[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vector-swarm-"))
    stores.clear()
    onWrite = () => {}
    route = () => undefined
    requests.length = 0
    prompted = Promise.withResolvers<void>()
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        const path = url.pathname
        requests.push(`${request.method} ${path}`)
        const routed = route(url, request)
        if (routed) return routed
        if (path === "/api/session") return Response.json({ data: { id: "planner" } })
        if (path === "/session") return Response.json({ id: "planner" })
        if (path === "/api/session/planner/prompt") {
          prompted.resolve()
          return Response.json({ data: {} })
        }
        if (path === "/api/session/active") return Response.json({ data: { planner: { type: "busy" } } })
        if (path === "/api/session/planner/interrupt") return new Response(null, { status: 204 })
        return new Response("Unexpected request", { status: 404 })
      },
    })
  })

  afterEach(async () => {
    for (const run of listSwarmRuns()) await stopSwarmRun(run.id)
    await server.stop(true)
    await rm(directory, { recursive: true, force: true })
  })

  async function seed(status: SwarmRunRecord["status"] = "interrupted", tasks: SwarmRunRecord["tasks"] = []) {
    const isolatedPath = join(directory, "staging", "repo")
    await mkdir(isolatedPath, { recursive: true })
    const run: SwarmRunRecord = {
      id: "swarm",
      name: "Test swarm",
      objective: "Inspect and improve the project",
      sourcePath: directory,
      strategy: "balanced",
      maxAgents: 4,
      maxConcurrency: 2,
      modelPool: [{ provider: "test", model: "test" }],
      plannerProvider: "test",
      plannerModel: "test",
      coordinatorWorkspaceId: "coordinator",
      status,
      currentStep: "Interrupted",
      progress: 0,
      planSummary: "",
      tasks,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      changedFiles: [],
      diff: "",
      riskLevel: "low",
      summary: "",
      logs: [],
    }
    stores.set("swarm-orchestrator-state", new Map([["runs", [run]]]))
    stores.set(
      "parallel-workspaces-state",
      new Map([
        [
          "records",
          [
            {
              id: "coordinator",
              name: "Staging",
              sourcePath: directory,
              isolatedPath,
              isolation: "copy",
              status: "complete",
              mergeState: "none",
              changedFiles: [],
              changedFilesCount: 0,
              diff: "",
              logs: [],
            },
          ],
        ],
      ]),
    )
    return run
  }

  test("stopping a planner interrupts admitted work and never launches fallback tasks", async () => {
    const run = await seed()
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    await prompted.promise
    const stopped = await stopSwarmRun(run.id)

    expect(stopped.status).toBe("canceled")
    expect(stopped.tasks).toEqual([])
    expect(getSwarmRun(run.id)?.status).toBe("canceled")
    expect(requests).toContain("POST /api/session/planner/interrupt")
    expect(stopped.logs.some((log) => log.includes("fallback"))).toBe(false)
  })

  // The planner's own answer, as the engine's session context holds it.
  const answer = (value: unknown) => ({
    type: "assistant",
    content: [{ type: "text", id: "answer", text: JSON.stringify(value) }],
  })

  // The planner reports busy once, then idle, and its session context holds `messages`, oldest first.
  async function plan(messages: unknown[]) {
    const run = await seed()
    let busy = true
    route = (url) => {
      if (url.pathname === "/api/session/active") {
        const active = busy ? { planner: { type: "busy" } } : {}
        busy = false
        return Response.json({ data: active })
      }
      if (url.pathname === "/api/session/planner/context") return Response.json({ data: messages })
      return undefined
    }
    const scheduled = Promise.withResolvers<SwarmRunRecord>()
    onWrite = (name) => {
      const current = name === "swarm-orchestrator-state" ? getSwarmRun(run.id) : undefined
      if (current?.tasks.length) scheduled.resolve(current)
    }
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const planned = await scheduled.promise
    await stopSwarmRun(run.id)
    return planned
  }

  test("a plan with null dependencies and one task too many is folded, not replaced by the fallback", async () => {
    const planned = await plan([
      answer({
        summary: "Five steps",
        tasks: [
          { id: "inspect", title: "Inspect", prompt: "Map the files", role: "explore", dependsOn: null },
          { id: "api", title: "API", prompt: "Change the API", dependsOn: ["inspect"] },
          { id: "ui", title: "UI", prompt: "Change the UI", dependsOn: ["inspect"] },
          { id: "test", title: "Test", prompt: "Run the tests", role: "test", dependsOn: ["api", "ui"] },
          { id: "review", title: "Review", prompt: "Review the diff", role: "review", dependsOn: ["test"] },
        ],
      }),
    ])

    expect(planned.tasks.map((task) => task.id)).toEqual(["inspect", "api", "ui", "test"])
    expect(planned.tasks[0]?.dependsOn).toEqual([])
    expect(planned.tasks[3]?.prompt).toContain("Run the tests")
    expect(planned.tasks[3]?.prompt).toContain("Review the diff")
    expect(planned.planSummary).toContain("The last 2 planned tasks run in order as one task")
    expect(planned.logs.some((log) => log.includes("fallback"))).toBe(false)
    expect(requests).not.toContain("POST /api/session/planner/interrupt")
  })

  test("a rejected plan falls back, logs why, and interrupts the planner", async () => {
    const planned = await plan([answer({ tasks: [{ id: "inspect" }, { id: "build", dependsOn: ["missing"] }] })])

    expect(planned.tasks.map((task) => task.id)).toEqual([
      "map-project",
      "implement-objective",
      "validate-result",
      "review-result",
    ])
    expect(planned.logs.some((log) => log.includes("fallback") && log.includes("unknown task missing"))).toBe(true)
    expect(requests).toContain("POST /api/session/planner/interrupt")
  })

  test("a JSON file the planner read is never taken for its plan", async () => {
    // A read tool's result: the project's .vscode/tasks.json, whose "tasks" array would pass as a two-task graph.
    const tasksFile = JSON.stringify({
      version: "2.0.0",
      tasks: [
        { label: "build", type: "shell", command: "npm run build" },
        { label: "test", type: "shell", command: "npm test" },
      ],
    })
    const planned = await plan([
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "read",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: ".vscode/tasks.json" },
              structured: {},
              content: [{ type: "text", text: tasksFile }],
            },
            time: { created: 0 },
          },
        ],
      },
      { type: "assistant", content: [{ type: "text", id: "final", text: "I could not finish the plan." }] },
    ])

    expect(planned.tasks.map((task) => task.id)).toEqual([
      "map-project",
      "implement-objective",
      "validate-result",
      "review-result",
    ])
    expect(
      planned.logs.some((log) => log.includes("fallback") && log.includes("did not return a JSON task graph")),
    ).toBe(true)
  })

  test("resuming an active swarm keeps its current scheduler and progress", async () => {
    const run = await seed()
    const engine = { url: server.url.toString(), directory }
    await resumeSwarmRun(run.id, engine)
    await prompted.promise
    const before = getSwarmRun(run.id)!
    const resumed = await resumeSwarmRun(run.id, engine)

    expect(resumed.logs).toEqual(before.logs)
    expect(resumed.currentStep).toBe(before.currentStep)
    expect(resumed.completedAt).toBeUndefined()
    expect(requests.filter((request) => request === "POST /api/session")).toHaveLength(1)
  })

  test("discard waits for planner cleanup before removing staging", async () => {
    const run = await seed()
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    await prompted.promise
    const discarded = await discardSwarmRun(run.id)

    expect(discarded.status).toBe("discarded")
    expect(getSwarmRun(run.id)?.status).toBe("discarded")
    expect(requests).toContain("POST /api/session/planner/interrupt")
    expect(await stat(join(directory, "staging")).catch(() => undefined)).toBeUndefined()
  })

  test("stopping during worker provisioning never starts the worker", async () => {
    const run = await seed("interrupted", [inspectTask])
    const creating = Promise.withResolvers<void>()
    onWrite = (name) => {
      if (name === "swarm-orchestrator-state" && getSwarmRun(run.id)?.tasks[0]?.status === "creating") {
        creating.resolve()
      }
    }
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    await creating.promise
    const stopped = await stopSwarmRun(run.id)

    expect(stopped.status).toBe("canceled")
    expect(stopped.tasks[0]?.status).toBe("canceled")
    expect(stopped.tasks[0]?.workspaceId).toBeTruthy()
    expect(stopped.tasks[0]?.completedAt).toBeTruthy()
    expect(requests).toEqual([])
    expect(getSwarmRun(run.id)?.status).toBe("canceled")
  })

  test("Stop returns within its bound while provisioning settles and retains cleanup ownership", async () => {
    const run = await seed("interrupted", [inspectTask])
    const creating = Promise.withResolvers<void>()
    onWrite = (name) => {
      if (name === "swarm-orchestrator-state" && getSwarmRun(run.id)?.tasks[0]?.status === "creating")
        creating.resolve()
    }
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    await creating.promise
    const started = Date.now()
    const stopped = await stopSwarmRun(run.id, 0)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(stopped.status).toBe("canceled")
    expect(stopped.currentStep).toContain("cleanup")
    const settled = await stopSwarmRun(run.id)
    expect(settled.tasks[0]?.status).toBe("canceled")
    expect(settled.tasks[0]?.workspaceId).toBeTruthy()
    expect(requests).toEqual([])
  })

  test("Resume joins pending cleanup on an inactive run and repeated Stop cannot cancel the new run", async () => {
    const run = await seed("interrupted", [{ ...inspectTask, status: "running", workspaceId: "staging" }])
    const cleaning = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stopped = stopSwarmRun(run.id, 0, async () => {
      cleaning.resolve()
      await release.promise
      return getParallelWorkspace("staging")!
    })
    await cleaning.promise
    expect((await stopped).currentStep).toContain("cleanup")
    const resuming = resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    let duplicateStops = 0
    const joined = await stopSwarmRun(run.id, 0, async () => {
      duplicateStops += 1
      return getParallelWorkspace("staging")!
    })
    expect(duplicateStops).toBe(0)
    expect(joined.status).toBe("canceled")
    expect(requests).toEqual([])
    release.resolve()
    expect((await resuming).status).toBe("running")
    await prompted.promise
    expect(getSwarmRun(run.id)?.status).toBe("running")
  })

  // A worker workspace from an earlier attempt, as the parallel workspace store keeps it.
  async function previousWorker(
    id: string,
    mergeState: "none" | "merged",
    extra: Partial<ParallelWorkspaceRecord> = {},
  ) {
    const isolatedPath = join(directory, id, "workspace")
    await mkdir(isolatedPath, { recursive: true })
    const records = stores.get("parallel-workspaces-state")!.get("records") as unknown[]
    stores.get("parallel-workspaces-state")!.set("records", [
      ...records,
      {
        id,
        name: "Previous attempt",
        sourcePath: join(directory, "staging", "repo"),
        isolatedPath,
        isolation: "copy",
        status: mergeState === "merged" ? "merged" : "failed",
        mergeState,
        changedFiles: ["result.txt"],
        changedFilesCount: 1,
        riskLevel: "medium",
        diff: "",
        logs: [],
        terminalOutput: [],
        browserResults: [],
        ...extra,
      },
    ])
    return isolatedPath
  }

  // Each worker session writes `<session>.txt` into its isolated copy, reports busy once and then goes idle.
  function workers() {
    const sessions = new Map<string, { directory: string; busy: boolean }>()
    route = async (url) => {
      if (url.pathname === "/session") {
        const id = `worker-${sessions.size + 1}`
        sessions.set(id, { directory: url.searchParams.get("directory") ?? "", busy: true })
        return Response.json({ id })
      }
      if (url.pathname === "/api/session/active") {
        const busy = [...sessions].filter(([, session]) => session.busy).map(([id]) => id)
        sessions.forEach((session) => (session.busy = false))
        return Response.json({ data: Object.fromEntries(busy.map((id) => [id, { type: "busy" }])) })
      }
      const [, id, action] = url.pathname.match(/^\/api\/session\/(worker-\d+)\/(prompt|message|context)$/) ?? []
      if (action === "prompt") {
        await writeFile(join(sessions.get(id)!.directory, `${id}.txt`), `${id}\n`)
        return Response.json({ data: {} })
      }
      if (action) return Response.json({ data: [] })
      return undefined
    }
  }

  async function settled(id: string) {
    const deadline = Date.now() + 30_000
    while (["planning", "running"].includes(getSwarmRun(id)!.status) && Date.now() < deadline) await Bun.sleep(25)
    return getSwarmRun(id)!
  }

  test("Resume releases a retried task's previous workspace instead of leaving its copy on disk", async () => {
    const run = await seed("failed", [{ ...inspectTask, status: "failed", workspaceId: "old-worker" }])
    const isolatedPath = await previousWorker("old-worker", "none")
    const resumed = await resumeSwarmRun(run.id, { url: server.url.toString(), directory })

    expect(resumed.tasks[0]?.workspaceId).not.toBe("old-worker")
    const deadline = Date.now() + 3_000
    while (getParallelWorkspace("old-worker")?.mergeState !== "discarded" && Date.now() < deadline) await Bun.sleep(20)
    expect(getParallelWorkspace("old-worker")?.mergeState).toBe("discarded")
    expect(await stat(isolatedPath).catch(() => undefined)).toBeUndefined()
  })

  test("Resume records a task complete when Vector closed after its changes merged into staging", async () => {
    const run = await seed("interrupted", [
      {
        ...inspectTask,
        status: "interrupted",
        workspaceId: "merged-worker",
        lastAction: "Interrupted when Vector closed",
      },
    ])
    const isolatedPath = await previousWorker("merged-worker", "merged", {
      validationPassed: true,
      finalSummary: "Mapped the project",
    })
    const resumed = await resumeSwarmRun(run.id, { url: server.url.toString(), directory })

    expect(resumed.tasks[0]?.status).toBe("complete")
    expect(resumed.tasks[0]?.workspaceId).toBe("merged-worker")
    expect(resumed.tasks[0]?.lastAction).toBe("Validated changes integrated into staging")
    expect(resumed.tasks[0]?.summary).toBe("Mapped the project")
    expect(resumed.tasks[0]?.changedFilesCount).toBe(1)
    expect(await stat(isolatedPath).catch(() => undefined)).toBeDefined()
    expect(requests).not.toContain("POST /session")
  })

  test.each([
    { validationPassed: true, lastAction: "Validated changes integrated into staging" },
    { validationPassed: undefined, lastAction: "Changes integrated into staging" },
  ])(
    "a failed task whose worker was merged by hand completes with the workspace's own result ($lastAction)",
    async (input) => {
      const failure = "Deterministic validation still failed after the bounded repair pass."
      const run = await seed("failed", [
        { ...inspectTask, status: "failed", workspaceId: "merged-worker", summary: failure, error: failure },
      ])
      await previousWorker("merged-worker", "merged", {
        validationPassed: input.validationPassed,
        finalSummary: "Merged 1 changed file into the main project.",
      })
      const resumed = await resumeSwarmRun(run.id, { url: server.url.toString(), directory })

      expect(resumed.tasks[0]?.status).toBe("complete")
      expect(resumed.tasks[0]?.lastAction).toBe(input.lastAction)
      expect(resumed.tasks[0]?.summary).toBe("Merged 1 changed file into the main project.")
      expect(resumed.tasks[0]?.error).toBeUndefined()
    },
  )

  test("a Stop still winding down when Vector closed resumes its stranded task and then the tasks after it", async () => {
    // Stop gave up waiting after 10 seconds and recorded the run canceled while the API worker was still merging.
    const run = await seed("canceled", [
      { ...inspectTask, id: "api", title: "API", status: "merging", workspaceId: "stranded" },
      { ...inspectTask, id: "ui", title: "UI", dependsOn: ["api"] },
    ])
    const stranded = await previousWorker("stranded", "none")
    const listed = listSwarmRuns()[0]
    expect(listed.status).toBe("canceled")
    expect(listed.currentStep).toBe("Swarm stopped")
    expect(listed.tasks.map((task) => task.status)).toEqual(["interrupted", "planned"])

    workers()
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const done = await settled(run.id)

    expect(done.status).toBe("complete")
    expect(done.tasks.map((task) => task.status)).toEqual(["complete", "complete"])
    expect(await Bun.file(join(directory, "staging", "repo", "worker-1.txt")).text()).toBe("worker-1\n")
    expect(await Bun.file(join(directory, "staging", "repo", "worker-2.txt")).text()).toBe("worker-2\n")
    expect(getParallelWorkspace("stranded")?.mergeState).toBe("discarded")
    expect(await stat(stranded).catch(() => undefined)).toBeUndefined()
  })

  test("Resume straight after a restart settles a task left merging and runs the tasks after it", async () => {
    const run = await seed("canceled", [
      { ...inspectTask, id: "api", title: "API", status: "merging", workspaceId: "merged-worker" },
      { ...inspectTask, id: "ui", title: "UI", dependsOn: ["api"] },
    ])
    await previousWorker("merged-worker", "merged", { validationPassed: true, finalSummary: "Changed the API" })
    workers()
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const done = await settled(run.id)

    expect(done.tasks.map((task) => task.status)).toEqual(["complete", "complete"])
    expect(done.tasks[1]?.workspaceId).toBeTruthy()
    expect(requests.filter((request) => request === "POST /session")).toHaveLength(1)
  })

  test("a restart while a merged worker's copy is being removed keeps the task complete without running it again", async () => {
    const run = await seed("interrupted", [inspectTask])
    workers()
    // What Vector has written when it closes during the cleanup that follows a worker's merge into staging.
    let snapshot: Map<string, Map<string, unknown>> | undefined
    let copyRemained = false
    onWrite = (name, _key, value) => {
      if (snapshot || name !== "parallel-workspaces-state") return
      const worker = (value as ParallelWorkspaceRecord[]).find((record) => record.swarmRole === "worker")
      if (worker?.mergeState !== "merged") return
      snapshot = new Map([...stores].map(([store, entries]) => [store, structuredClone(entries)]))
      copyRemained = existsSync(worker.isolatedPath)
    }
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const first = await settled(run.id)
    expect(first.tasks[0]?.status).toBe("complete")
    expect(copyRemained).toBe(true)

    // Restart: the stores hold what was written at that moment and nothing in memory owns the run.
    stores.clear()
    snapshot!.forEach((entries, store) => stores.set(store, entries))
    expect(listSwarmRuns()[0]?.tasks[0]?.status).toBe("interrupted")
    const resumed = await resumeSwarmRun(run.id, { url: server.url.toString(), directory })

    expect(resumed.tasks[0]?.status).toBe("complete")
    expect(resumed.tasks[0]?.workspaceId).toBe(first.tasks[0]?.workspaceId)
    expect((await settled(run.id)).status).toBe("complete")
    expect(requests.filter((request) => request === "POST /session")).toHaveLength(1)
  })

  test("Resume finishes a merge into staging that Vector closed part-way through instead of running the task again", async () => {
    const run = await seed("interrupted", [{ ...inspectTask, status: "interrupted", workspaceId: "partial" }])
    const isolatedPath = await previousWorker("partial", "none", {
      status: "complete",
      baselineHashes: {},
      changedFiles: ["a.txt", "b.txt"],
      changedFilesCount: 2,
      validationPassed: true,
      finalSummary: "Changed a and b",
      mergeStartedAt: new Date().toISOString(),
    })
    await writeFile(join(isolatedPath, "a.txt"), "worker\n")
    await writeFile(join(isolatedPath, "b.txt"), "worker\n")
    // The merge had copied a.txt into staging when Vector closed.
    await writeFile(join(directory, "staging", "repo", "a.txt"), "worker\n")
    const resumed = await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    expect(resumed.tasks[0]?.workspaceId).toBe("partial")
    const done = await settled(run.id)

    expect(done.tasks[0]?.status).toBe("complete")
    expect(done.tasks[0]?.summary).toBe("Changed a and b")
    expect(await Bun.file(join(directory, "staging", "repo", "a.txt")).text()).toBe("worker\n")
    expect(await Bun.file(join(directory, "staging", "repo", "b.txt")).text()).toBe("worker\n")
    expect(getParallelWorkspace("partial")?.mergeState).toBe("merged")
    expect(requests).not.toContain("POST /session")
  })

  function patchRun(fields: Partial<SwarmRunRecord>) {
    const bucket = stores.get("swarm-orchestrator-state")!
    bucket.set("runs", (bucket.get("runs") as SwarmRunRecord[]).map((run) => ({ ...run, ...fields })))
  }

  function patchWorkspace(id: string, fields: Partial<ParallelWorkspaceRecord>) {
    const bucket = stores.get("parallel-workspaces-state")!
    bucket.set(
      "records",
      (bucket.get("records") as ParallelWorkspaceRecord[]).map((record) =>
        record.id === id ? { ...record, ...fields } : record,
      ),
    )
  }

  // A real worker workspace made from staging, as the scheduler makes one.
  function stagingWorker(task: string) {
    return createParallelWorkspace({
      sourcePath: join(directory, "staging", "repo"),
      parentSessionId: "swarm:swarm",
      name: `Test swarm · ${task}`,
      taskPrompt: task,
      swarmRunId: "swarm",
      swarmTaskId: task,
      swarmRole: "worker",
    })
  }

  // The API worker changed a.txt and created sub/new.txt. Its merge into staging copied a.txt and then could not create
  // sub/new.txt, which is where a merge Vector closed during, or one whose write failed, stops.
  async function stoppedMerge() {
    const staging = join(directory, "staging", "repo")
    const worker = await stagingWorker("api")
    await mkdir(join(worker.isolatedPath, "sub"), { recursive: true })
    await writeFile(join(worker.isolatedPath, "a.txt"), "api\n")
    await writeFile(join(worker.isolatedPath, "sub", "new.txt"), "api\n")
    await chmod(join(staging, "sub"), 0o555)
    const stopped = await mergeParallelWorkspace(worker.id).finally(() => chmod(join(staging, "sub"), 0o755))
    expect(stopped.status).toBe("failed")
    expect(await Bun.file(join(staging, "a.txt")).text()).toBe("api\n")
    expect(existsSync(join(staging, "sub", "new.txt"))).toBe(false)
    return stopped
  }

  async function stagingFiles() {
    const staging = join(directory, "staging", "repo")
    await mkdir(join(staging, "sub"), { recursive: true })
    await writeFile(join(staging, "a.txt"), "before\n")
    return staging
  }

  test("Resume undoes a merge into staging that stopped part-way and merges the worker afresh without running it again", async () => {
    const run = await seed("failed")
    const staging = await stagingFiles()
    const stopped = await stoppedMerge()
    patchRun({
      tasks: [{ ...inspectTask, id: "api", title: "API", status: "failed", workspaceId: stopped.id, error: stopped.error }],
    })
    workers()
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const done = await settled(run.id)

    expect(done.tasks[0]?.status).toBe("complete")
    expect(done.tasks[0]?.lastAction).toBe("Validated changes integrated into staging")
    expect(await Bun.file(join(staging, "a.txt")).text()).toBe("api\n")
    expect(await Bun.file(join(staging, "sub", "new.txt")).text()).toBe("api\n")
    expect(getParallelWorkspace(stopped.id)?.mergeState).toBe("merged")
    expect(getParallelWorkspace(stopped.id)?.logs.some((log) => log.includes("Vector undid an unfinished merge"))).toBe(
      true,
    )
    expect(requests).not.toContain("POST /session")
  })

  test("undoing an unfinished merge never reverts a sibling's change merged after it", async () => {
    const run = await seed("canceled")
    const staging = await stagingFiles()
    // The UI worker finished and passed its checks before Stop, so its merge never began. It also created sub/new.txt.
    const sibling = await stagingWorker("ui")
    await mkdir(join(sibling.isolatedPath, "sub"), { recursive: true })
    await writeFile(join(sibling.isolatedPath, "sub", "new.txt"), "ui\n")
    await refreshParallelWorkspace(sibling.id)
    patchWorkspace(sibling.id, { status: "complete", validationPassed: true })
    const stopped = await stoppedMerge()
    // One agent slot, and the UI task first: it merges before the API task starts.
    patchRun({
      maxConcurrency: 1,
      tasks: [
        { ...inspectTask, id: "ui", title: "UI", status: "canceled", workspaceId: sibling.id },
        { ...inspectTask, id: "api", title: "API", status: "failed", workspaceId: stopped.id, error: stopped.error },
      ],
    })
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const done = await settled(run.id)

    expect(await Bun.file(join(staging, "sub", "new.txt")).text()).toBe("ui\n")
    expect(await Bun.file(join(staging, "a.txt")).text()).toBe("before\n")
    expect(done.tasks.map((task) => task.status)).toEqual(["complete", "failed"])
    expect(done.tasks[1]?.error).toContain("Merge conflict detected in sub/new.txt")
    expect(requests).not.toContain("POST /session")
  })

  test("a task completed from its merged worker keeps the agent's summary, not the merge's", async () => {
    const run = await seed("interrupted", [{ ...inspectTask, status: "interrupted", workspaceId: "merged-worker" }])
    await previousWorker("merged-worker", "merged", {
      validationPassed: true,
      summaryBeforeMerge: "Mapped the API",
      finalSummary: "Merged 1 changed file into swarm staging.",
    })
    const resumed = await resumeSwarmRun(run.id, { url: server.url.toString(), directory })

    expect(resumed.tasks[0]?.status).toBe("complete")
    expect(resumed.tasks[0]?.summary).toBe("Mapped the API")
  })

  test("stopping an executing worker interrupts its session before the scheduler finishes", async () => {
    const run = await seed("interrupted", [inspectTask])
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    await prompted.promise
    const stopped = await stopSwarmRun(run.id)

    expect(stopped.status).toBe("canceled")
    expect(stopped.tasks[0]?.status).toBe("canceled")
    expect(getParallelWorkspace(stopped.tasks[0]!.workspaceId!)?.status).toBe("stopped")
    expect(requests).toContain("POST /api/session/planner/interrupt")
    expect(stopped.tasks.some((task) => task.status === "complete")).toBe(false)
  })

  test("Discard finishes when the engine never answers a worker's interrupt", async () => {
    const run = await seed("interrupted", [inspectTask])
    // The worker's session is "planner" (the default session ID). Its interrupt is held open until Vector gives up.
    route = (url, request) => {
      if (url.pathname !== "/api/session/planner/interrupt") return undefined
      const abandoned = Promise.withResolvers<Response>()
      request.signal.addEventListener("abort", () => abandoned.resolve(new Response(null, { status: 204 })))
      return abandoned.promise
    }
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    await prompted.promise
    const started = Date.now()
    const discarded = await discardSwarmRun(run.id)

    expect(Date.now() - started).toBeLessThan(9_000)
    expect(discarded.status).toBe("discarded")
    expect(discarded.tasks[0]?.status).toBe("canceled")
    expect(requests).toContain("POST /api/session/planner/interrupt")
    expect(await stat(join(directory, "staging")).catch(() => undefined)).toBeUndefined()
  }, 30_000)

  test("stopping while a worker's changes merge into staging keeps the task complete", async () => {
    const run = await seed("interrupted", [inspectTask])
    // The worker's engine session edits its isolated copy, reports busy once and then goes idle with no error.
    let worker = ""
    let busy = true
    route = async (url) => {
      if (url.pathname === "/session") {
        worker = url.searchParams.get("directory") ?? ""
        return Response.json({ id: "worker" })
      }
      if (url.pathname === "/api/session/worker/prompt") {
        await writeFile(join(worker, "result.txt"), "inspected\n")
        return Response.json({ data: {} })
      }
      if (url.pathname === "/api/session/active") {
        const active = busy ? { worker: { type: "busy" } } : {}
        busy = false
        return Response.json({ data: active })
      }
      if (url.pathname === "/api/session/worker/message") return Response.json({ data: [] })
      if (url.pathname === "/api/session/worker/context") return Response.json({ data: [] })
      return undefined
    }
    // Stop lands while the merge into staging is under way, after the worker validated and finished.
    let stopping: Promise<SwarmRunRecord> | undefined
    onWrite = (name) => {
      if (name !== "swarm-orchestrator-state" || stopping) return
      if (getSwarmRun(run.id)?.tasks[0]?.status === "merging") stopping = stopSwarmRun(run.id)
    }
    await resumeSwarmRun(run.id, { url: server.url.toString(), directory })
    const deadline = Date.now() + 30_000
    while (!stopping && Date.now() < deadline) await Bun.sleep(50)
    if (!stopping) throw new Error("The worker never reached the staging merge.")
    const stopped = await stopping

    expect(stopped.status).toBe("canceled")
    expect(stopped.tasks[0]?.status).toBe("complete")
    expect(stopped.tasks[0]?.lastAction).toBe("Validated changes integrated into staging")
    expect(await Bun.file(join(directory, "staging", "repo", "result.txt")).text()).toBe("inspected\n")
    expect(getParallelWorkspace(stopped.tasks[0]!.workspaceId!)?.mergeState).toBe("merged")
  })

  test.each(["complete", "needs review", "merged", "discarded"] as const)(
    "stopping a settled %s swarm preserves its outcome",
    async (status) => {
      const run = await seed(status)
      expect((await stopSwarmRun(run.id)).status).toBe(status)
      expect(requests).toEqual([])
    },
  )
})
