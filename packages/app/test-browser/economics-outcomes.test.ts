import { afterEach, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createOutcomes, listOutcomes, recordOutcome, removeOutcome } from "@/features/economics/economics-repository"
import type { ModelOutcome } from "@/features/economics/economics-types"

const originalApi = Object.getOwnPropertyDescriptor(window, "api")

afterEach(() => {
  if (originalApi) Object.defineProperty(window, "api", originalApi)
  if (!originalApi) Reflect.deleteProperty(window, "api")
  localStorage.clear()
})

function outcome(projectId: string, costUsd = 0.01): ModelOutcome {
  return {
    id: "session:s1",
    projectId,
    provider: "openai",
    model: "model",
    category: "general",
    createdAt: 1,
    hadChecks: false,
    latencyMs: 100,
    changedFiles: 1,
    costUsd,
  }
}

test("changing projects immediately hides the previous history and ignores older reads", async () => {
  const reads: ((value: string | null) => void)[] = []
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { storeGet: () => new Promise<string | null>((resolve) => reads.push(resolve)) },
  })
  const state = createRoot((dispose) => {
    const [project, setProject] = createSignal("/repo/a")
    return { dispose, setProject, outcomes: createOutcomes(project) }
  })
  reads[0]!(JSON.stringify([outcome("/repo/a")]))
  await Bun.sleep(0)
  expect(state.outcomes()[0]?.projectId).toBe("/repo/a")
  state.setProject("/repo/b")
  expect(state.outcomes()).toEqual([])
  state.setProject("/repo/a")
  reads[2]!(JSON.stringify([outcome("/repo/a", 5)]))
  await Bun.sleep(0)
  expect(state.outcomes()[0]?.costUsd).toBe(5)
  state.setProject("/repo/b")
  reads[3]!(JSON.stringify([outcome("/repo/b", 6)]))
  await Bun.sleep(0)
  reads[1]!(JSON.stringify([outcome("/repo/b")]))
  await Bun.sleep(0)
  expect(state.outcomes()[0]?.costUsd).toBe(6)
  state.dispose()
})

test("recording and removing cumulative session samples refreshes consumers", async () => {
  Reflect.deleteProperty(window, "api")
  const state = createRoot((dispose) => ({ dispose, outcomes: createOutcomes(() => "/economics/reactive") }))
  await recordOutcome(outcome("/economics/reactive"))
  await Bun.sleep(0)
  expect(state.outcomes()[0]?.costUsd).toBe(0.01)
  await recordOutcome(outcome("/economics/reactive", 5))
  await Bun.sleep(0)
  expect(state.outcomes()).toHaveLength(1)
  expect(state.outcomes()[0]?.costUsd).toBe(5)
  await removeOutcome("/economics/reactive", "session:s1")
  await Bun.sleep(0)
  expect(state.outcomes()).toEqual([])
  state.dispose()
})

test("a failed desktop read cannot overwrite or remove existing history", async () => {
  let stored = JSON.stringify([outcome("/economics/retry")])
  let failRead = true
  let writes = 0
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      storeGet: async () => {
        if (failRead) throw new Error("storage temporarily unavailable")
        return stored
      },
      storeSet: async (_name: string, _key: string, value: string) => {
        writes += 1
        stored = value
      },
    },
  })
  await expect(recordOutcome({ ...outcome("/economics/retry", 5), id: "session:s2" })).rejects.toThrow(
    "storage temporarily unavailable",
  )
  await expect(removeOutcome("/economics/retry", "session:s1")).rejects.toThrow("storage temporarily unavailable")
  expect(writes).toBe(0)
  failRead = false
  await recordOutcome({ ...outcome("/economics/retry", 5), id: "session:s2" })
  expect((await listOutcomes("/economics/retry")).map((entry) => entry.id)).toEqual(["session:s1", "session:s2"])
})
