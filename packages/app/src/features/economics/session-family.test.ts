import { expect, test } from "bun:test"
import type { Event } from "@vectordevai/sdk/v2"
import { createSessionFamilyRefresher, sessionFamilyEventID } from "./session-family"
import { createSessionOutcomeRecorder, outcomeFromSession } from "./session-outcomes"
import type { ModelOutcome } from "./economics-types"

test("settlement and child lifecycle events invalidate the family, streaming events do not", () => {
  for (const type of ["session.idle", "session.next.ancillary.usage", "session.next.step.ended", "session.next.compaction.failed", "message.part.removed", "message.removed"]) {
    expect(sessionFamilyEventID({ type, properties: { sessionID: "child" } } as Event)).toBe("child")
  }
  expect(sessionFamilyEventID({ type: "message.part.updated", properties: { sessionID: "child", part: { type: "step-finish" } } } as Event)).toBe("child")
  expect(sessionFamilyEventID({ type: "message.part.updated", properties: { sessionID: "child", part: { type: "text" } } } as Event)).toBeUndefined()
  expect(sessionFamilyEventID({ type: "session.updated", properties: { info: { id: "child", parentID: "root" } } } as Event)).toBe("child")
  expect(sessionFamilyEventID({ type: "session.updated", properties: { info: { id: "root" } } } as Event)).toBeUndefined()
  expect(sessionFamilyEventID({ type: "session.deleted", properties: { info: { id: "child", parentID: "root" } } } as Event)).toBe("root")
  expect(sessionFamilyEventID({ type: "session.deleted", properties: { info: { id: "root" } } } as Event)).toBeUndefined()
})

test("late grandchild settlement refreshes one root sample without another parent turn", async () => {
  const root = { id: "root", directory: "/repo", time: { updated: 100 }, cost: 0.1, subagentCost: 0, subagentUnpricedSteps: 0 }
  const child = { id: "child", directory: "/repo", parentID: root.id, time: { updated: 100 } }
  const grandchild = { id: "grandchild", directory: "/repo/child", parentID: child.id, time: { updated: 100 } }
  const samples = new Map<string, ModelOutcome>()
  const recorder = createSessionOutcomeRecorder(async (sessionID, directory, current) => {
    const outcome = outcomeFromSession({
      sessionID, projectId: directory, spend: root,
      messages: [{ info: { id: "assistant", role: "assistant", providerID: "openai", modelID: "main", cost: 0.1, tokens: { input: 100, output: 2 }, time: { created: 10, completed: 90 } } }],
      parts: {},
    })
    if (outcome && current()) samples.set(sessionID, outcome)
  })
  const calls: string[] = []
  const family = createSessionFamilyRefresher(
    async (id) => [root, child, grandchild].find(session => session.id === id),
    async (id, directory, revision) => {
      calls.push(id)
      return recorder.refresh(id, directory, revision)
    },
  )
  await family.refresh(root.id, root.directory)
  root.subagentCost = 0.3
  root.time.updated = 101
  await family.refresh(grandchild.id, grandchild.directory)
  expect(samples.size).toBe(1)
  expect(samples.get("root")).toMatchObject({ model: "main", latencyMs: 80, costUsd: 0.4, usage: { input: 100, output: 2 } })
  root.subagentUnpricedSteps = 1
  root.time.updated = 102
  await family.refresh(child.id, child.directory)
  expect(samples.get("root")?.costUsd).toBeUndefined()
  expect(samples.get("root")?.costPriced).toBeUndefined()
  expect(samples.get("root")?.latencyMs).toBe(80)
  await family.refresh(grandchild.id, grandchild.directory)
  expect(calls).toEqual(["root", "root", "root"])
  family.dispose()
  recorder.dispose()
})

test("duplicate notifications coalesce, while a newer settlement invalidates an in-flight snapshot", async () => {
  const root = { id: "root", directory: "/repo", time: { updated: 1 } }
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const committed: number[] = []
  const recorder = createSessionOutcomeRecorder(async (_id, _directory, current) => {
    const revision = root.time.updated
    if (revision === 1) {
      started.resolve()
      await release.promise
    }
    if (current()) committed.push(revision)
  })
  const family = createSessionFamilyRefresher(async () => root, async (id, directory, revision) => {
    return recorder.refresh(id, directory, revision)
  })
  const first = family.refresh("child", "/repo")
  await started.promise
  root.time.updated = 2
  // A different descendant's event can arrive while the first child's capture is pending.
  const next = family.refresh("grandchild", "/repo")
  await Promise.resolve()
  release.resolve()
  await Promise.all([first, next, family.refresh("grandchild", "/repo")])
  expect(committed).toEqual([2])
  await family.refresh("child", "/repo")
  expect(committed).toEqual([2])
  root.time.updated = 1
  await family.refresh("grandchild", "/repo")
  expect(committed).toEqual([2])
  family.dispose()
  recorder.dispose()
})

test("a later child event retries the same root revision after bounded capture failures", async () => {
  const root = { id: "root", directory: "/repo", time: { updated: 10 } }
  const state = { attempts: 0, fail: true }
  const committed: string[] = []
  const recorder = createSessionOutcomeRecorder(async (id, _directory, current) => {
    state.attempts += 1
    if (state.fail) throw new Error("outcome storage unavailable")
    if (current()) committed.push(id)
  })
  const family = createSessionFamilyRefresher(
    async (id) => id === root.id ? root : { id, parentID: root.id, directory: "/repo", time: { updated: 1 } },
    (id, directory, revision) => recorder.refresh(id, directory, revision),
  )
  await family.refresh("child", "/repo")
  expect(state.attempts).toBe(3)
  expect(committed).toEqual([])
  state.fail = false
  await family.refresh("child", "/repo")
  expect(state.attempts).toBe(4)
  expect(committed).toEqual(["root"])
  expect(root.time.updated).toBe(10)
  await family.refresh("grandchild", "/repo")
  expect(state.attempts).toBe(4)
  family.dispose()
  recorder.dispose()
})

test("failed ancestry reads and a deleted child do not suppress the retained parent's settlement", async () => {
  const root = { id: "root", directory: "/repo", time: { updated: 10 } }
  const state = { fail: true }
  const committed: string[] = []
  const recorder = createSessionOutcomeRecorder(async (id, _directory, current) => {
    if (current()) committed.push(id)
  })
  const family = createSessionFamilyRefresher(
    async (id) => {
      if (state.fail) throw new Error("session metadata unavailable")
      return id === root.id ? root : undefined
    },
    (id, directory, revision) => recorder.refresh(id, directory, revision),
  )
  await expect(family.refresh("child", "/repo")).rejects.toThrow("session metadata unavailable")
  state.fail = false
  await family.refresh("child", "/repo")
  expect(committed).toEqual([])
  const parentID = sessionFamilyEventID({ type: "session.deleted", properties: { info: { id: "child", parentID: root.id } } } as Event)
  expect(parentID).toBe(root.id)
  await family.refresh(parentID!, "/repo")
  expect(committed).toEqual([root.id])
  family.dispose()
  recorder.dispose()
})

test("family resolution does not substitute another root for missing or cyclic ancestry", async () => {
  const calls: string[] = []
  const family = createSessionFamilyRefresher(
    async (id) => id === "missing" ? undefined : { id, parentID: id === "a" ? "b" : "a", directory: "/repo", time: { updated: 1 } },
    async (id) => { calls.push(id); return true },
  )
  await family.refresh("missing", "/repo")
  await family.refresh("a", "/repo")
  expect(calls).toEqual([])
  family.dispose()
})

test("disposed family refreshes cannot write when metadata resolves later", async () => {
  const gate = Promise.withResolvers<{ id: string; directory: string; time: { updated: number } }>()
  const calls: string[] = []
  const family = createSessionFamilyRefresher(() => gate.promise, async (id) => { calls.push(id); return true })
  const pending = family.refresh("root", "/repo")
  family.dispose()
  gate.resolve({ id: "root", directory: "/repo", time: { updated: 1 } })
  await pending
  expect(calls).toEqual([])
})

test("disposing during root capture prevents its write and acknowledgement", async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const committed: string[] = []
  const acknowledged: boolean[] = []
  const recorder = createSessionOutcomeRecorder(async (id, _directory, current) => {
    started.resolve()
    await release.promise
    if (current()) committed.push(id)
  })
  const family = createSessionFamilyRefresher(
    async () => ({ id: "root", directory: "/repo", time: { updated: 1 } }),
    async (id, directory, revision) => {
      const result = await recorder.refresh(id, directory, revision)
      acknowledged.push(result)
      return result
    },
  )
  const pending = family.refresh("child", "/repo")
  await started.promise
  family.dispose()
  recorder.dispose()
  release.resolve()
  await pending
  expect(committed).toEqual([])
  expect(acknowledged).toEqual([false])
})
