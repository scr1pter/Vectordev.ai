import { describe, expect, test } from "bun:test"
import {
  elapsedLabel,
  isDirected,
  orderConversation,
  findClashes,
  groupAgents,
  isFinished,
  isRunning,
  needsAttention,
  sortForDisplay,
  summarize,
  type DashboardAgentInput,
} from "./agent-dashboard-model"

let counter = 0
function agent(partial: Partial<DashboardAgentInput> = {}): DashboardAgentInput {
  counter += 1
  return {
    id: `agent-${counter}`,
    name: `Agent ${counter}`,
    taskPrompt: "do the thing",
    runtime: "vector",
    provider: "anthropic",
    model: "claude-sonnet-5",
    status: "editing",
    progress: 40,
    lastAction: "editing src/index.ts",
    createdAt: "2026-08-15T20:00:00.000Z",
    lastActivityAt: "2026-08-15T20:05:00.000Z",
    changedFilesCount: 1,
    changedFiles: ["src/index.ts"],
    estimatedCost: "$0.10",
    mergeState: "none",
    ...partial,
  }
}

describe("status predicates", () => {
  test("classifies running, finished, and attention states", () => {
    expect(isRunning("editing")).toBe(true)
    expect(isRunning("complete")).toBe(false)
    expect(isFinished("merged")).toBe(true)
    expect(isFinished("needs review")).toBe(false)
    expect(needsAttention(agent({ status: "failed" }))).toBe(true)
    expect(needsAttention(agent({ status: "needs review" }))).toBe(true)
    expect(needsAttention(agent({ status: "editing", error: "boom" }))).toBe(true)
    expect(needsAttention(agent({ status: "editing" }))).toBe(false)
  })
})

describe("findClashes", () => {
  test("reports two live agents holding the same file", () => {
    const clashes = findClashes([
      agent({ name: "Alpha", changedFiles: ["src/a.ts", "src/shared.ts"] }),
      agent({ name: "Beta", changedFiles: ["src/b.ts", "src/shared.ts"] }),
    ])
    expect(clashes).toHaveLength(1)
    expect(clashes[0]!.file).toBe("src/shared.ts")
    expect(clashes[0]!.agentNames.sort()).toEqual(["Alpha", "Beta"])
  })

  test("does not report a file only one agent touches", () => {
    expect(findClashes([agent({ changedFiles: ["a.ts"] }), agent({ changedFiles: ["b.ts"] })])).toEqual([])
  })

  test("ignores merged and discarded agents so resolved work is not a permanent alarm", () => {
    const clashes = findClashes([
      agent({ changedFiles: ["src/shared.ts"], mergeState: "merged", status: "merged" }),
      agent({ changedFiles: ["src/shared.ts"] }),
    ])
    expect(clashes).toEqual([])
  })

  test("ignores finished agents even when merge state is still none", () => {
    expect(
      findClashes([
        agent({ changedFiles: ["src/shared.ts"], status: "complete" }),
        agent({ changedFiles: ["src/shared.ts"], status: "stopped" }),
      ]),
    ).toEqual([])
  })

  test("counts a duplicated path within one agent only once", () => {
    expect(findClashes([agent({ changedFiles: ["dup.ts", "dup.ts"] })])).toEqual([])
  })

  test("reports every clashing file, sorted", () => {
    const clashes = findClashes([agent({ changedFiles: ["z.ts", "a.ts"] }), agent({ changedFiles: ["a.ts", "z.ts"] })])
    expect(clashes.map((clash) => clash.file)).toEqual(["a.ts", "z.ts"])
  })
})

describe("summarize", () => {
  test("counts live, blocked, finished, unique files, and clashes", () => {
    const summary = summarize([
      agent({ status: "editing", changedFiles: ["a.ts"] }),
      agent({ status: "failed", changedFiles: ["a.ts"] }),
      agent({ status: "merged", mergeState: "merged", changedFiles: ["b.ts"] }),
    ])
    expect(summary.total).toBe(3)
    expect(summary.running).toBe(1)
    expect(summary.attention).toBe(1)
    expect(summary.finished).toBe(1)
    expect(summary.changedFiles).toBe(2)
    expect(summary.clashes).toBe(1)
  })

  test("is all zeroes for no agents", () => {
    expect(summarize([])).toEqual({ total: 0, running: 0, attention: 0, finished: 0, changedFiles: 0, clashes: 0, teams: 0 })
  })
})

describe("groupAgents", () => {
  test("groups a swarm together and puts the coordinator first", () => {
    const groups = groupAgents([
      agent({ name: "Worker", swarmRunId: "run-1", swarmRole: "worker" }),
      agent({ name: "Lead", swarmRunId: "run-1", swarmRole: "coordinator" }),
      agent({ name: "Solo" }),
    ])
    const swarm = groups.find((group) => group.swarm)
    expect(swarm?.agents.map((item) => item.name)).toEqual(["Lead", "Worker"])
    expect(swarm?.label).toBe("Lead")
    expect(groups.filter((group) => !group.swarm).map((group) => group.label)).toEqual(["Solo"])
  })

  test("each standalone agent is its own group", () => {
    expect(groupAgents([agent(), agent()]).every((group) => group.agents.length === 1)).toBe(true)
  })
})

describe("sortForDisplay", () => {
  test("running first, then attention, then the rest", () => {
    const sorted = sortForDisplay([
      agent({ name: "done", status: "complete" }),
      agent({ name: "broken", status: "failed" }),
      agent({ name: "live", status: "editing" }),
    ])
    expect(sorted.map((item) => item.name)).toEqual(["live", "broken", "done"])
  })
})

describe("elapsedLabel", () => {
  const now = Date.parse("2026-08-15T20:10:00.000Z")

  test("counts to now while running", () => {
    expect(elapsedLabel(agent({ status: "editing" }), now)).toBe("10m 0s")
  })

  test("freezes at last activity once finished", () => {
    expect(elapsedLabel(agent({ status: "complete" }), now)).toBe("5m 0s")
  })

  test("formats seconds and hours", () => {
    expect(elapsedLabel(agent({ createdAt: "2026-08-15T20:09:30.000Z", status: "editing" }), now)).toBe("30s")
    expect(elapsedLabel(agent({ createdAt: "2026-08-15T18:00:00.000Z", status: "editing" }), now)).toBe("2h 10m")
  })

  test("is empty for an unparseable timestamp", () => {
    expect(elapsedLabel(agent({ createdAt: "not a date" }), now)).toBe("")
  })
})

describe("team conversation", () => {
  const message = (id: string, createdAt: string, toWorkspaceId?: string) => ({
    id,
    fromWorkspaceId: "a",
    fromName: "Alpha",
    toWorkspaceId,
    text: "t",
    createdAt,
  })

  test("orders a transcript oldest first", () => {
    const ordered = orderConversation([
      message("second", "2026-08-15T20:05:00.000Z"),
      message("first", "2026-08-15T20:00:00.000Z"),
    ])
    expect(ordered.map((m) => m.id)).toEqual(["first", "second"])
  })

  test("does not mutate the input", () => {
    const input = [message("b", "2026-08-15T20:05:00.000Z"), message("a", "2026-08-15T20:00:00.000Z")]
    orderConversation(input)
    expect(input.map((m) => m.id)).toEqual(["b", "a"])
  })

  test("distinguishes a directed reply from a broadcast handoff", () => {
    expect(isDirected(message("x", "2026-08-15T20:00:00.000Z", "b"))).toBe(true)
    expect(isDirected(message("y", "2026-08-15T20:00:00.000Z"))).toBe(false)
  })
})

describe("summarize teams", () => {
  test("counts distinct teams and ignores agents without one", () => {
    expect(summarize([agent({ teamId: "t1" }), agent({ teamId: "t1" }), agent({ teamId: "t2" }), agent()]).teams).toBe(2)
  })
})
