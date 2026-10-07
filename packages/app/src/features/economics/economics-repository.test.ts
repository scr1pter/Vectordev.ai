import { beforeEach, describe, expect, test } from "bun:test"
import { listOutcomes, outcomesFromWorkspaceRecord, recordOutcome, removeOutcome } from "./economics-repository"
import type { ModelOutcome } from "./economics-types"

// Minimal in-memory Storage fake, mirroring utils/persist.test.ts's approach —
// the desktop electron-store IPC (window.api.storeGet/Set) isn't present in
// this test environment, so recordOutcome/listOutcomes exercise the
// localStorage fallback path.
class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
}

const storage = new MemoryStorage()

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true })
})

function makeOutcome(partial: Partial<ModelOutcome> & Pick<ModelOutcome, "id" | "projectId">): ModelOutcome {
  return {
    provider: "anthropic",
    model: "claude-sonnet-5",
    category: "general",
    createdAt: Date.now(),
    hadChecks: false,
    latencyMs: 100,
    changedFiles: 1,
    ...partial,
  }
}

describe("economics-repository", () => {
  test("records and lists outcomes for a project", async () => {
    await recordOutcome(makeOutcome({ id: "o1", projectId: "/repo/a", model: "claude-sonnet-5" }))
    const outcomes = await listOutcomes("/repo/a")
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.model).toBe("claude-sonnet-5")
  })

  test("outcomes recorded at the same time are all kept", async () => {
    await Promise.all(["w1", "w2", "w3"].map((id) => recordOutcome(makeOutcome({ id, projectId: "/repo/concurrent" }))))
    expect((await listOutcomes("/repo/concurrent")).map((outcome) => outcome.id).sort()).toEqual(["w1", "w2", "w3"])
  })

  test("refreshes cumulative session spend without counting later idle events as separate runs", async () => {
    await recordOutcome(makeOutcome({ id: "session:s1", projectId: "/repo/a", costUsd: 0.01, latencyMs: 100 }))
    await recordOutcome(makeOutcome({ id: "workspace:w1", projectId: "/repo/a", costUsd: 0.5 }))
    await recordOutcome(
      makeOutcome({ id: "session:s1", projectId: "/repo/a", costUsd: 5, latencyMs: 1_000, changedFiles: 3 }),
    )
    const outcomes = await listOutcomes("/repo/a")
    expect(outcomes).toHaveLength(2)
    expect(outcomes.find((outcome) => outcome.id === "session:s1")?.costUsd).toBe(5)
    expect(outcomes.find((outcome) => outcome.id === "session:s1")?.changedFiles).toBe(3)
    await recordOutcome(makeOutcome({ id: "workspace:w1", projectId: "/repo/a", costUsd: 9 }))
    expect((await listOutcomes("/repo/a")).find((outcome) => outcome.id === "workspace:w1")?.costUsd).toBe(9)
    expect(await listOutcomes("/repo/a")).toHaveLength(2)
  })

  test("removes a superseded session sample in order with concurrent writes", async () => {
    await Promise.all([
      recordOutcome(makeOutcome({ id: "session:s1", projectId: "/repo/a", costUsd: 0.01 })),
      recordOutcome(makeOutcome({ id: "workspace:w1", projectId: "/repo/a", costUsd: 0.5 })),
      removeOutcome("/repo/a", "session:s1"),
    ])
    expect((await listOutcomes("/repo/a")).map((outcome) => outcome.id)).toEqual(["workspace:w1"])
    await removeOutcome("/repo/a", "missing")
    expect(await listOutcomes("/repo/a")).toHaveLength(1)
  })

  test("ignores malformed records and records belonging to a different project", async () => {
    const valid = makeOutcome({ id: "good", projectId: "/repo/a" })
    await recordOutcome(valid)
    storage.setItem(
      storage.key(0)!,
      JSON.stringify([
        null,
        { category: "frontend" },
        { ...valid, id: "foreign", projectId: "/repo/b" },
        { ...valid, id: "broken-usage", usage: { input: 10 } },
        valid,
      ]),
    )
    expect((await listOutcomes("/repo/a")).map((outcome) => outcome.id)).toEqual(["good"])
  })

  test("keeps separate projects isolated", async () => {
    await recordOutcome(makeOutcome({ id: "a1", projectId: "/repo/a" }))
    await recordOutcome(makeOutcome({ id: "b1", projectId: "/repo/b" }))
    expect(await listOutcomes("/repo/a")).toHaveLength(1)
    expect(await listOutcomes("/repo/b")).toHaveLength(1)
    expect((await listOutcomes("/repo/a"))[0]?.id).toBe("a1")
  })

  test("caps stored outcomes at 500 per project, keeping the most recent", async () => {
    for (let i = 0; i < 510; i++) {
      await recordOutcome(makeOutcome({ id: `o${i}`, projectId: "/repo/c" }))
    }
    const outcomes = await listOutcomes("/repo/c")
    expect(outcomes).toHaveLength(500)
    expect(outcomes[0]?.id).toBe("o10")
    expect(outcomes[outcomes.length - 1]?.id).toBe("o509")
  })

  test("maps a completed workspace record into an outcome", () => {
    const result = outcomesFromWorkspaceRecord(
      {
        id: "ws-1",
        provider: "anthropic",
        model: "claude-sonnet-5",
        sourcePath: "/repo/a",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActivityAt: "2026-01-01T00:05:00.000Z",
        changedFilesCount: 4,
        validationReport: { hadChecks: true, passed: true },
      },
      "backend",
    )
    expect(result?.latencyMs).toBe(5 * 60 * 1000)
    expect(result?.hadChecks).toBe(true)
    expect(result?.checksPassed).toBe(true)
    expect(result?.category).toBe("backend")
    expect(result?.projectId).toBe("/repo/a")
  })

  test("mapper falls back to 0 latency when timestamps are unparsable", () => {
    const result = outcomesFromWorkspaceRecord(
      {
        id: "ws-2",
        provider: "anthropic",
        model: "claude-sonnet-5",
        sourcePath: "/repo/a",
        createdAt: "not-a-date",
        lastActivityAt: "also-not-a-date",
        changedFilesCount: 0,
      },
      "general",
    )
    expect(result?.latencyMs).toBe(0)
    expect(result?.latencyMeasured).toBe(false)
    expect(result?.hadChecks).toBe(false)
    expect(result?.checksPassed).toBeUndefined()
  })

  test("does not charge a workspace's selected model for switched-model aggregate usage", () => {
    const record = {
      id: "workspace:w1",
      provider: "openai",
      model: "small",
      sourcePath: "/repo/a",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:01:00.000Z",
      changedFilesCount: 1,
    }
    const measured = {
      usage: { input: 100, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 5,
      messageCount: 2,
    }
    expect(outcomesFromWorkspaceRecord(record, "frontend", measured)).toBeUndefined()
    expect(
      outcomesFromWorkspaceRecord(record, "frontend", { ...measured, provider: "openai", model: "different" }),
    ).toBeUndefined()
    expect(
      outcomesFromWorkspaceRecord(record, "frontend", { ...measured, provider: "openai", model: "small" })?.costUsd,
    ).toBe(5)
  })
})
