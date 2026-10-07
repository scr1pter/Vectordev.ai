import { describe, expect, test } from "bun:test"
import { createSessionOutcomeRecorder } from "./session-outcome-recorder"

describe("session outcome refresh", () => {
  test("coalesces idle events during a read and refreshes again after it settles", async () => {
    const firstRead = Promise.withResolvers<{}>()
    const started = Promise.withResolvers<void>()
    const saves: string[] = []
    let reads = 0
    const recorder = createSessionOutcomeRecorder({
      load: async () => {
        reads++
        if (reads !== 1) return {}
        started.resolve()
        return firstRead.promise
      },
      save: async (project, id) => {
        saves.push(`${project}:${id}`)
      },
    })
    const first = recorder.refresh("repo", "session")
    await started.promise
    const next = recorder.refresh("repo", "session")
    recorder.refresh("repo", "session")
    expect(next).toBe(first)
    expect(reads).toBe(1)
    firstRead.resolve({})
    await first
    expect(reads).toBe(2)
    expect(saves).toEqual(["repo:session", "repo:session"])
    await recorder.refresh("repo", "session")
    expect(reads).toBe(3)
  })

  test("does not erase stored history when a read is unavailable, and retries a later idle", async () => {
    const saves: unknown[] = []
    let reads = 0
    const recorder = createSessionOutcomeRecorder({
      load: async () => (++reads === 1 ? undefined : {}),
      save: async (project, id, outcome) => {
        saves.push([project, id, outcome])
      },
    })
    await recorder.refresh("repo", "session")
    expect(saves).toEqual([])
    await recorder.refresh("repo", "session")
    expect(saves).toEqual([["repo", "session", undefined]])
  })

  test("a persistence failure can be retried on the next idle", async () => {
    let attempts = 0
    const recorder = createSessionOutcomeRecorder({
      load: async () => ({}),
      save: async () => {
        if (++attempts === 1) throw new Error("Storage unavailable")
      },
    })
    await expect(recorder.refresh("repo", "session")).rejects.toThrow("Storage unavailable")
    await recorder.refresh("repo", "session")
    expect(attempts).toBe(2)
  })

  test("keeps repositories independent even for the same session identifier", async () => {
    const reads: string[] = []
    const recorder = createSessionOutcomeRecorder({
      load: async (project, id) => {
        reads.push(`${project}:${id}`)
        return {}
      },
      save: async () => {},
    })
    await Promise.all([recorder.refresh("repo-a", "session"), recorder.refresh("repo-b", "session")])
    expect(reads).toEqual(["repo-a:session", "repo-b:session"])
  })

  test("disposing during a read prevents writes and queued followups", async () => {
    const read = Promise.withResolvers<{}>()
    const started = Promise.withResolvers<void>()
    const saves: string[] = []
    const recorder = createSessionOutcomeRecorder({
      load: async () => {
        started.resolve()
        return read.promise
      },
      save: async () => {
        saves.push("saved")
      },
    })
    const pending = recorder.refresh("repo", "session")
    await started.promise
    recorder.refresh("repo", "session")
    recorder.dispose()
    read.resolve({})
    await pending
    await recorder.refresh("repo", "session")
    expect(saves).toEqual([])
  })
})
