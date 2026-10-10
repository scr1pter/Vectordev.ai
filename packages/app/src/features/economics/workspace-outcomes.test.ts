import { describe, expect, test } from "bun:test"
import { createWorkspaceOutcomeRecorder, type WorkspaceOutcomeRecord } from "./workspace-outcomes"
import { listOutcomes, outcomesFromWorkspaceRecord, recordWorkspaceOutcome } from "./economics-repository"
import { measureUsage } from "./token-usage"

function workspace(project: string): WorkspaceOutcomeRecord {
  return {
    id: "workspace",
    sourcePath: `/workspace-recorder/${project}`,
    isolatedPath: `/worktree/${project}`,
    agentSessionId: "session",
    taskPrompt: "Fix the parser",
    provider: "provider",
    model: "model",
    status: "complete",
    revision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:01Z",
    changedFilesCount: 1,
    validationReport: { hadChecks: true, passed: true },
  }
}

const persist = async (record: WorkspaceOutcomeRecord, current: () => boolean) => {
  const outcome = outcomesFromWorkspaceRecord(
    record,
    "backend",
    measureUsage([
      {
        role: "assistant",
        providerID: record.provider,
        modelID: record.model,
        tokens: { input: 10, output: 5 },
        cost: 0.25,
      },
    ]),
    { cost: 0.25 },
  )!
  const result = await recordWorkspaceOutcome(
    outcome,
    {
      workspaceRevision: record.revision ?? 0,
      sessionID: record.agentSessionId,
      sessionUpdatedAt: 10,
    },
    current,
  )
  if (result === "stale") throw new Error("Superseded evidence")
}

describe("workspace outcome recording", () => {
  test("unchanged polling and activity-only revisions reuse a successful capture", async () => {
    const record = workspace("unchanged")
    const captured: WorkspaceOutcomeRecord[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (value) => {
      captured.push(value)
    })
    expect(await recorder.observe(record)).toBe(true)
    for (const revision of [1, 2, 3, 4, 5])
      expect(await recorder.observe({ ...record, revision, lastActivityAt: `2026-01-01T00:00:0${revision}Z` })).toBe(
        true,
      )
    expect(captured).toHaveLength(1)
    recorder.dispose()
  })

  test("a validation change updates the stored outcome without new session usage", async () => {
    const record = workspace("validation")
    const recorder = createWorkspaceOutcomeRecorder(persist)
    expect(await recorder.observe(record)).toBe(true)
    expect((await listOutcomes(record.sourcePath))[0]?.checksPassed).toBe(true)
    expect(
      await recorder.observe({ ...record, revision: 2, validationReport: { hadChecks: true, passed: false } }),
    ).toBe(true)
    const stored = await listOutcomes(record.sourcePath)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ costUsd: 0.25, checksPassed: false, hadChecks: true })
    recorder.dispose()
  })

  test("transient capture failures retry without being marked recorded", async () => {
    const record = workspace("retry")
    const calls: string[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (value, current) => {
      calls.push(value.id)
      if (calls.length < 3) throw new Error("Session read failed")
      await persist(value, current)
    })
    expect(await recorder.observe(record)).toBe(true)
    expect(await recorder.observe(record)).toBe(true)
    expect(calls).toHaveLength(3)
    expect(await listOutcomes(record.sourcePath)).toHaveLength(1)
    recorder.dispose()
  })

  test("persistent failures stop after three attempts until a fresh notification", async () => {
    const record = workspace("bounded")
    const calls: string[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (value) => {
      calls.push(value.id)
      if (calls.length <= 3) throw new Error("Session unavailable")
    })
    expect(await recorder.observe(record)).toBe(false)
    expect(await recorder.observe(record)).toBe(false)
    expect(await recorder.observe({ ...record, revision: 2 })).toBe(false)
    expect(calls).toHaveLength(3)
    expect(await recorder.observe(record, true)).toBe(false)
    expect(await recorder.observe({ ...record, revision: 2 }, true)).toBe(true)
    expect(calls).toHaveLength(4)
    recorder.dispose()
  })

  test("coalesces in-flight captures and records only the newest validation", async () => {
    const record = workspace("in-flight")
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const captured: boolean[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (value, current) => {
      captured.push(value.validationReport!.passed)
      started.resolve()
      await release.promise
      if (current()) await persist(value, current)
    })
    const first = recorder.observe(record)
    await started.promise
    const latest = { ...record, revision: 2, validationReport: { hadChecks: true, passed: false } }
    const second = recorder.observe(latest)
    const repeated = recorder.observe(latest)
    release.resolve()
    expect(await Promise.all([first, second, repeated])).toEqual([true, true, true])
    expect(captured).toEqual([true, false])
    expect((await listOutcomes(record.sourcePath))[0]?.checksPassed).toBe(false)
    recorder.dispose()
  })

  test("a new running state invalidates an older terminal capture", async () => {
    const record = workspace("running")
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const recorder = createWorkspaceOutcomeRecorder(async (value, current) => {
      started.resolve()
      await release.promise
      if (current()) await persist(value, current)
    })
    const first = recorder.observe(record)
    await started.promise
    expect(await recorder.observe({ ...record, revision: 2, status: "editing" })).toBe(false)
    release.resolve()
    expect(await first).toBe(false)
    expect(await listOutcomes(record.sourcePath)).toHaveLength(0)
    expect(await recorder.observe({ ...record, revision: 3 })).toBe(true)
    expect(await listOutcomes(record.sourcePath)).toHaveLength(1)
    recorder.dispose()
  })

  test("disposal prevents an in-flight capture from recording or restarting", async () => {
    const record = workspace("disposed")
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const recorder = createWorkspaceOutcomeRecorder(async (value, current) => {
      started.resolve()
      await release.promise
      if (current()) await persist(value, current)
    })
    const pending = recorder.observe(record)
    await started.promise
    recorder.dispose()
    release.resolve()
    expect(await pending).toBe(false)
    expect(await recorder.observe(record, true)).toBe(false)
    expect(await listOutcomes(record.sourcePath)).toHaveLength(0)
  })

  test("older workspace records cannot replace a newer observation", async () => {
    const record = workspace("stale")
    const captured: number[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (value) => {
      captured.push(value.revision!)
    })
    expect(await recorder.observe({ ...record, revision: 5 })).toBe(true)
    expect(await recorder.observe({ ...record, revision: 4, validationPassed: false }, true)).toBe(true)
    expect(captured).toEqual([5])
    recorder.dispose()
  })

  test("forced usage notifications coalesce while a capture is pending", async () => {
    const record = workspace("force")
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const captured: number[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (_value, current) => {
      captured.push(captured.length)
      started.resolve()
      await release.promise
      if (!current()) return
    })
    const first = recorder.observe(record)
    await started.promise
    const notifications = Array.from({ length: 10 }, () => recorder.observe(record, true))
    release.resolve()
    expect(await first).toBe(true)
    expect((await Promise.all(notifications)).every(Boolean)).toBe(true)
    expect(captured).toHaveLength(2)
    recorder.dispose()
  })

  test("identical workspace IDs in different projects have independent captures", async () => {
    const captured: string[] = []
    const recorder = createWorkspaceOutcomeRecorder(async (value) => {
      captured.push(value.sourcePath)
    })
    expect(
      await Promise.all([recorder.observe(workspace("project-a")), recorder.observe(workspace("project-b"))]),
    ).toEqual([true, true])
    expect(captured).toEqual(["/workspace-recorder/project-a", "/workspace-recorder/project-b"])
    recorder.dispose()
  })
})
