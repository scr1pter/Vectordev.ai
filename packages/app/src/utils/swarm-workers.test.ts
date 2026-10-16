import { describe, expect, test } from "bun:test"
import { listSwarmWorkers } from "./swarm-workers"

const run = (id: string, workspaceIds: (string | undefined)[]) => ({
  id,
  tasks: workspaceIds.map((workspaceId) => ({ workspaceId })),
})

describe("listSwarmWorkers", () => {
  test("reads each swarm's workers under the swarm's scope, once per swarm, in task order", async () => {
    const scopes: string[] = []
    const store = [
      { id: "coordinator-a", parentSessionId: "swarm:a" },
      { id: "worker-a2", parentSessionId: "swarm:a" },
      { id: "worker-a1", parentSessionId: "swarm:a" },
      { id: "worker-b1", parentSessionId: "swarm:b" },
    ]
    const workers = await listSwarmWorkers({
      runs: [run("a", ["worker-a1", undefined, "worker-a2", "worker-a1"]), run("b", ["worker-b1"])],
      listed: [],
      list: async (scope) => {
        scopes.push(scope.parentSessionId)
        return store.filter((record) => record.parentSessionId === scope.parentSessionId)
      },
    })
    expect(scopes).toEqual(["swarm:a", "swarm:b"])
    // The coordinator is not one of the tasks' workers, and a worker named by two tasks appears once.
    expect(workers.map((record) => record.id)).toEqual(["worker-a1", "worker-a2", "worker-b1"])
  })

  test("skips a swarm whose workers the task's own list already returned", async () => {
    const scopes: string[] = []
    const workers = await listSwarmWorkers({
      runs: [run("a", ["worker-a1"]), run("b", [undefined])],
      listed: [{ id: "worker-a1" }],
      list: async (scope) => {
        scopes.push(scope.parentSessionId)
        return []
      },
    })
    expect(scopes).toEqual([])
    expect(workers).toEqual([])
  })

  test("leaves out the workers of a swarm whose list failed, and keeps the others", async () => {
    const workers = await listSwarmWorkers({
      runs: [run("a", ["worker-a1"]), run("b", ["worker-b1", "worker-b2"])],
      listed: [],
      list: async (scope) => {
        if (scope.parentSessionId === "swarm:a") throw new Error("desktop unavailable")
        return [{ id: "worker-b1" }]
      },
    })
    // A worker the desktop no longer has is left out too, as a failed refresh left it out.
    expect(workers).toEqual([{ id: "worker-b1" }])
  })
})
