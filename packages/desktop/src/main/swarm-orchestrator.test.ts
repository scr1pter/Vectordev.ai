import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParallelWorkspaceRecord } from "./parallel-workspaces"

// Module stubs must stay in a separate registry: other desktop suites import
// the real workspace/store modules in the same Bun test process.
if (process.env.VECTOR_SWARM_REGRESSION_PROCESS !== "1") {
  test("swarm lifecycle regression suite", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, VECTOR_SWARM_REGRESSION_PROCESS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`Isolated swarm regressions failed:\n${stdout}\n${stderr}`)
    expect(code).toBe(0)
  }, 30_000)
} else {
  // Electron persistence and worker admission are the boundaries under test. No
  // worker or model is launched; planner HTTP uses a local server below.
  const store = new Map<string, unknown>()
  const workspaces = new Map<string, ParallelWorkspaceRecord>()
  const launched: string[] = []
  const stopped: string[] = []
  const discarded: string[] = []
  const interrupted: string[] = []
  let sourcePath = ""
  let blockedRole: "coordinator" | "worker" | undefined
  let created = Promise.withResolvers<string>()
  let releaseCreation = Promise.withResolvers<void>()
  let plannerPrompted = Promise.withResolvers<void>()
  let releasePlanner = Promise.withResolvers<void>()
  let blockPlanner = false
  let blockAdmission = false
  let holdWorkers = false
  let blockStops = false
  let blockStat = false
  let plannerSessionId = ""
  let plannerAdmitted = Promise.withResolvers<void>()
  let releaseAdmission = Promise.withResolvers<void>()
  let releaseStops = Promise.withResolvers<void>()
  let statChecked = Promise.withResolvers<void>()
  let releaseStat = Promise.withResolvers<void>()
  let plannerObservedBusy = false
  let parallelPlan = false
  let separateReleases = false
  const pendingCreations = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const filesystemStat = stat

  mock.module("node:fs/promises", () => ({
    mkdtemp,
    rm,
    stat: async (path: string) => {
      if (blockStat) {
        statChecked.resolve()
        await releaseStat.promise
      }
      return filesystemStat(path)
    },
  }))

  mock.module("./store", () => ({
    getStore: () => ({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => store.set(key, value),
    }),
  }))
  mock.module("./parallel-workspaces", () => ({
    createParallelWorkspace: async (input: {
      swarmRole: "coordinator" | "worker"
      swarmTaskId?: string
      sourcePath: string
    }) => {
      const id = `${input.swarmRole}-${workspaces.size}`
      const workspace: ParallelWorkspaceRecord = {
        id,
        name: id,
        taskPrompt: "Inspect the project",
        runtime: "vector",
        provider: "test",
        model: "test",
        sourcePath: input.sourcePath,
        isolatedPath: sourcePath,
        isolation: "copy",
        status: "complete",
        progress: 100,
        lastAction: "Inspected project",
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        changedFilesCount: 0,
        changedFiles: [],
        diff: "",
        riskLevel: "low",
        estimatedCost: "$0",
        finalSummary: "Inspected project",
        mergeState: "none",
        logs: [],
        terminalOutput: [],
        browserResults: [],
      }
      workspaces.set(id, workspace)
      if (input.swarmRole === blockedRole) {
        created.resolve(id)
        const release = separateReleases ? Promise.withResolvers<void>() : releaseCreation
        pendingCreations.set(id, release)
        await release.promise
      }
      return workspace
    },
    getParallelWorkspace: (id: string) => workspaces.get(id),
    refreshParallelWorkspace: async (id: string) => workspaces.get(id)!,
    runParallelWorkspace: async (id: string) => {
      launched.push(id)
      if (holdWorkers) workspaces.get(id)!.status = "editing"
      return workspaces.get(id)!
    },
    stopParallelWorkspace: async (id: string) => {
      stopped.push(id)
      if (blockStops) await releaseStops.promise
      return workspaces.get(id)!
    },
    discardParallelWorkspace: async (id: string) => {
      discarded.push(id)
      return workspaces.get(id)!
    },
    mergeParallelWorkspace: async (id: string) => workspaces.get(id)!,
    mergeParallelWorkspaceSelection: async (id: string) => workspaces.get(id)!,
  }))

  const { createSwarmRun, discardSwarmRun, getSwarmRun, resumeSwarmRun, stopSwarmRun } = await import(
    "./swarm-orchestrator"
  )

  let server: ReturnType<typeof Bun.serve>
  const engine = () => ({ url: server.url.toString(), username: null, password: null })
  const launch = () =>
    createSwarmRun(
      { sourcePath, objective: "Inspect and report the project", primaryProvider: "test", primaryModel: "test" },
      engine(),
    )

  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 3_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Swarm did not publish the expected state.")
      await Bun.sleep(1)
    }
  }

  describe("swarm cancellation", () => {
    beforeEach(async () => {
      sourcePath = await mkdtemp(join(tmpdir(), "vector-swarm-"))
      store.clear()
      workspaces.clear()
      launched.length = 0
      stopped.length = 0
      discarded.length = 0
      interrupted.length = 0
      blockedRole = undefined
      blockPlanner = false
      blockAdmission = false
      holdWorkers = false
      blockStops = false
      blockStat = false
      plannerSessionId = ""
      plannerAdmitted = Promise.withResolvers<void>()
      releaseAdmission = Promise.withResolvers<void>()
      releaseStops = Promise.withResolvers<void>()
      statChecked = Promise.withResolvers<void>()
      releaseStat = Promise.withResolvers<void>()
      plannerObservedBusy = false
      parallelPlan = false
      separateReleases = false
      pendingCreations.clear()
      created = Promise.withResolvers<string>()
      releaseCreation = Promise.withResolvers<void>()
      plannerPrompted = Promise.withResolvers<void>()
      releasePlanner = Promise.withResolvers<void>()
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          if (path === "/api/session") {
            plannerSessionId = ((await request.json()) as { id: string }).id
            plannerAdmitted.resolve()
            if (blockAdmission) await releaseAdmission.promise
            return Response.json({ data: { id: plannerSessionId } })
          }
          if (path === `/api/session/${plannerSessionId}/interrupt`) {
            interrupted.push(plannerSessionId)
            return Response.json({ data: {} })
          }
          if (path === `/api/session/${plannerSessionId}/prompt`) {
            plannerPrompted.resolve()
            if (blockPlanner) await releasePlanner.promise
            return Response.json({ data: {} })
          }
          if (path === "/api/session/active") {
            const active = plannerObservedBusy ? {} : { [plannerSessionId]: { type: "busy" } }
            plannerObservedBusy = true
            return Response.json({ data: active })
          }
          if (path === `/api/session/${plannerSessionId}/context`) {
            return Response.json({
              data: [
                {
                  type: "text",
                  text: JSON.stringify({
                    tasks: [{ id: "inspect" }, { id: "report", dependsOn: parallelPlan ? [] : ["inspect"] }],
                  }),
                },
              ],
            })
          }
          return new Response("Unknown test route", { status: 404 })
        },
      })
    })

    afterEach(async () => {
      releaseCreation.resolve()
      for (const pending of pendingCreations.values()) pending.resolve()
      releasePlanner.resolve()
      releaseAdmission.resolve()
      releaseStops.resolve()
      releaseStat.resolve()
      server.stop(true)
      await rm(sourcePath, { recursive: true, force: true })
    })

    test("stopping during staging creation prevents planning and keeps the run canceled", async () => {
      blockedRole = "coordinator"
      const run = await launch()
      const workspaceId = await created.promise
      await stopSwarmRun(run.id)
      await expect(resumeSwarmRun(run.id, engine())).rejects.toThrow("still stopping")
      expect(getSwarmRun(run.id)?.status).toBe("canceled")
      releaseCreation.resolve()
      await waitFor(() => getSwarmRun(run.id)?.summary === "The swarm was stopped by the user.")
      expect(stopped).toContain(workspaceId)
      expect(getSwarmRun(run.id)?.coordinatorWorkspaceId).toBe(workspaceId)
      expect(getSwarmRun(run.id)?.tasks).toEqual([])
      expect(launched).toEqual([])
    })

    test("a canceled planner request cannot launch the fallback graph", async () => {
      blockPlanner = true
      const run = await launch()
      await plannerPrompted.promise
      await stopSwarmRun(run.id)
      releasePlanner.resolve()
      await waitFor(() => getSwarmRun(run.id)?.summary === "The swarm was stopped by the user.")
      expect(getSwarmRun(run.id)?.status).toBe("canceled")
      expect(getSwarmRun(run.id)?.tasks).toEqual([])
      expect(getSwarmRun(run.id)?.logs.some((log) => log.includes("fallback graph"))).toBe(false)
      expect(launched).toEqual([])
      expect(interrupted).toContain(plannerSessionId)
      expect(interrupted.length).toBeGreaterThanOrEqual(2)
    })

    test("a worker created after Stop is stopped before it can run", async () => {
      blockedRole = "worker"
      const run = await launch()
      const workspaceId = await created.promise
      await stopSwarmRun(run.id)
      releaseCreation.resolve()
      await waitFor(() => stopped.includes(workspaceId))
      expect(launched).toEqual([])
      expect(getSwarmRun(run.id)?.status).toBe("canceled")
      expect(getSwarmRun(run.id)?.tasks.every((task) => task.status === "canceled")).toBe(true)
    })

    test("a worker created after Discard is cleaned up without reviving its task", async () => {
      blockedRole = "worker"
      const run = await launch()
      const workspaceId = await created.promise
      const discardedRun = await discardSwarmRun(run.id)
      releaseCreation.resolve()
      await waitFor(() => discarded.includes(workspaceId))
      expect(launched).toEqual([])
      expect(getSwarmRun(run.id)).toEqual(discardedRun)
      expect(getSwarmRun(run.id)?.status).toBe("discarded")
    })

    test("Resume waits for every stopped worker creation to drain", async () => {
      blockedRole = "worker"
      parallelPlan = true
      separateReleases = true
      const run = await launch()
      await waitFor(() => pendingCreations.size === 2)
      await stopSwarmRun(run.id)
      const workers = [...pendingCreations]
      workers[0]![1].resolve()
      await waitFor(() => stopped.includes(workers[0]![0]))
      await expect(resumeSwarmRun(run.id, engine())).rejects.toThrow("still stopping")
      expect(getSwarmRun(run.id)?.status).toBe("canceled")
      workers[1]![1].resolve()
      await waitFor(() => stopped.includes(workers[1]![0]))
      expect(launched).toEqual([])
      expect(getSwarmRun(run.id)?.tasks.every((task) => task.status === "canceled")).toBe(true)
    })

    test("retries failed review tasks while preserving completed staged work", async () => {
      const initial = await launch()
      await waitFor(() => getSwarmRun(initial.id)?.status === "complete")
      const completed = getSwarmRun(initial.id)!
      store.set("runs", [
        {
          ...completed,
          status: "needs review",
          tasks: completed.tasks.map((task) =>
            task.id === "report" ? { ...task, status: "failed", error: "Provider unavailable" } : task,
          ),
        },
      ])
      const retried = await resumeSwarmRun(initial.id, engine())
      expect(retried.status).toBe("running")
      expect(retried.completedAt).toBeUndefined()
      expect(retried.tasks[0]).toEqual(completed.tasks[0])
      await waitFor(() => getSwarmRun(initial.id)?.status === "complete")
      expect(launched).toHaveLength(3)
      expect(getSwarmRun(initial.id)?.tasks.every((task) => task.status === "complete")).toBe(true)
    })

    test("keeps a fully completed graph awaiting review instead of rerunning it", async () => {
      const initial = await launch()
      await waitFor(() => getSwarmRun(initial.id)?.status === "complete")
      const completed = { ...getSwarmRun(initial.id)!, status: "needs review" }
      store.set("runs", [completed])
      expect(await resumeSwarmRun(initial.id, engine())).toEqual(completed)
      expect(launched).toHaveLength(2)
    })

    test("Stop interrupts the reserved planner identity during session admission", async () => {
      blockAdmission = true
      const run = await launch()
      await plannerAdmitted.promise
      expect(getSwarmRun(run.id)?.plannerSessionId).toBe(plannerSessionId)
      await stopSwarmRun(run.id)
      releaseAdmission.resolve()
      await waitFor(() => getSwarmRun(run.id)?.summary === "The swarm was stopped by the user.")
      expect(interrupted).toContain(plannerSessionId)
      expect(getSwarmRun(run.id)?.tasks).toEqual([])
      expect(launched).toEqual([])
    })

    test("Discard explicitly interrupts the planner without reviving the run", async () => {
      blockPlanner = true
      const run = await launch()
      await plannerPrompted.promise
      const discardedRun = await discardSwarmRun(run.id)
      releasePlanner.resolve()
      await waitFor(() => interrupted.length >= 2)
      expect(getSwarmRun(run.id)).toEqual(discardedRun)
      expect(interrupted).toContain(plannerSessionId)
      expect(launched).toEqual([])
    })

    test("Resume keeps ownership until already-running workers finish stopping", async () => {
      holdWorkers = true
      const run = await launch()
      await waitFor(() => getSwarmRun(run.id)?.tasks.some((task) => task.status === "running") === true)
      blockStops = true
      const stopping = stopSwarmRun(run.id)
      await waitFor(() => getSwarmRun(run.id)?.tasks.every((task) => task.status === "canceled") === true)
      await expect(resumeSwarmRun(run.id, engine())).rejects.toThrow("still stopping")
      releaseStops.resolve()
      await stopping
      expect(getSwarmRun(run.id)?.status).toBe("canceled")
    })

    for (const [name, action] of [
      ["Stop", stopSwarmRun],
      ["Discard", discardSwarmRun],
    ] as const) {
      test(`${name} during the Resume filesystem check cannot resurrect a run`, async () => {
        const run = await launch()
        await waitFor(() => getSwarmRun(run.id)?.status === "complete")
        store.set("runs", [{ ...getSwarmRun(run.id)!, status: "canceled" }])
        blockStat = true
        statChecked = Promise.withResolvers<void>()
        releaseStat = Promise.withResolvers<void>()
        const resuming = resumeSwarmRun(run.id, engine())
        await statChecked.promise
        const stoppedRun = await action(run.id)
        releaseStat.resolve()
        expect(await resuming).toEqual(stoppedRun)
        expect(getSwarmRun(run.id)).toEqual(stoppedRun)
        blockStat = false
      })
    }
  })
}
