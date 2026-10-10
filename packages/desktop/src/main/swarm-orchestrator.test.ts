import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
const { getParallelWorkspace } = await import("./parallel-workspaces")
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
  const requests: string[] = []

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vector-swarm-"))
    stores.clear()
    onWrite = () => {}
    requests.length = 0
    prompted = Promise.withResolvers<void>()
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        requests.push(`${request.method} ${path}`)
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

  test.each(["complete", "needs review", "merged", "discarded"] as const)(
    "stopping a settled %s swarm preserves its outcome",
    async (status) => {
      const run = await seed(status)
      expect((await stopSwarmRun(run.id)).status).toBe(status)
      expect(requests).toEqual([])
    },
  )
})
