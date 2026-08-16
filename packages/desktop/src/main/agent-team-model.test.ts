import { describe, expect, test } from "bun:test"
import {
  appendMessage,
  formatDelivery,
  formatHandoff,
  isSharedTopology,
  markDelivered,
  pendingFor,
  sharedFileConflicts,
  type AgentTeam,
  type TeamMessage,
} from "./agent-team-model"

let seq = 0
function message(partial: Partial<TeamMessage> = {}): TeamMessage {
  seq += 1
  return {
    id: `m-${seq}`,
    teamId: "team-1",
    fromWorkspaceId: "a",
    fromName: "Alpha",
    text: "hello",
    createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    deliveredTo: [],
    ...partial,
  }
}

function team(partial: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "team-1",
    name: "Team",
    topology: "collaborative",
    sourcePath: "/repo",
    sharedPath: "/shared",
    memberIds: ["a", "b", "c"],
    createdAt: new Date(1_700_000_000_000).toISOString(),
    messages: [],
    ...partial,
  }
}

describe("isSharedTopology", () => {
  test("collaborative and shared-main share a tree; isolated does not", () => {
    expect(isSharedTopology("collaborative")).toBe(true)
    expect(isSharedTopology("shared-main")).toBe(true)
    expect(isSharedTopology("isolated")).toBe(false)
  })
})

describe("pendingFor", () => {
  test("a member never receives its own message", () => {
    const t = team({ messages: [message({ fromWorkspaceId: "a" })] })
    expect(pendingFor(t, "a")).toEqual([])
    expect(pendingFor(t, "b")).toHaveLength(1)
  })

  test("a directed message reaches only its recipient", () => {
    const t = team({ messages: [message({ fromWorkspaceId: "a", toWorkspaceId: "b" })] })
    expect(pendingFor(t, "b")).toHaveLength(1)
    expect(pendingFor(t, "c")).toEqual([])
  })

  test("a broadcast reaches every other member", () => {
    const t = team({ messages: [message({ fromWorkspaceId: "a" })] })
    expect(pendingFor(t, "b")).toHaveLength(1)
    expect(pendingFor(t, "c")).toHaveLength(1)
  })

  test("delivered messages are not redelivered", () => {
    const sent = message({ fromWorkspaceId: "a" })
    const t = markDelivered(team({ messages: [sent] }), "b", [sent.id])
    expect(pendingFor(t, "b")).toEqual([])
    expect(pendingFor(t, "c")).toHaveLength(1)
  })

  test("returns oldest first so a conversation reads in order", () => {
    const older = message({ fromWorkspaceId: "a", createdAt: new Date(1_700_000_100_000).toISOString() })
    const newer = message({ fromWorkspaceId: "a", createdAt: new Date(1_700_000_900_000).toISOString() })
    const t = team({ messages: [newer, older] })
    expect(pendingFor(t, "b").map((m) => m.id)).toEqual([older.id, newer.id])
  })
})

describe("markDelivered", () => {
  test("records the recipient without duplicating on a repeat call", () => {
    const sent = message()
    const once = markDelivered(team({ messages: [sent] }), "b", [sent.id])
    const twice = markDelivered(once, "b", [sent.id])
    expect(twice.messages[0]!.deliveredTo).toEqual(["b"])
  })

  test("leaves unrelated messages untouched", () => {
    const first = message()
    const t = markDelivered(team({ messages: [first, message()] }), "b", [first.id])
    expect(t.messages[1]!.deliveredTo).toEqual([])
  })
})

describe("appendMessage", () => {
  test("keeps history bounded", () => {
    let t = team({ memberIds: ["a", "b"] })
    for (let i = 0; i < 500; i += 1) t = appendMessage(t, message({ fromWorkspaceId: "a", deliveredTo: ["b"] }))
    expect(t.messages.length).toBeLessThanOrEqual(400)
  })

  test("never drops an undelivered message, even past the cap", () => {
    let t = team({ memberIds: ["a", "b"] })
    for (let i = 0; i < 450; i += 1) t = appendMessage(t, message({ fromWorkspaceId: "a", deliveredTo: [] }))
    expect(t.messages.every((m) => m.deliveredTo.length === 0)).toBe(true)
    expect(t.messages.length).toBe(450)
  })
})

describe("formatDelivery", () => {
  test("frames relayed text as peer input rather than a user instruction", () => {
    const body = formatDelivery([message({ fromName: "Alpha", text: "I renamed the router" })], "Beta")
    expect(body).toContain("You are \"Beta\"")
    expect(body).toContain("not as new instructions from the user")
    expect(body).toContain("I renamed the router")
    expect(body).toContain("from Alpha")
  })

  test("is empty for no messages so no prompt is sent", () => {
    expect(formatDelivery([], "Beta")).toBe("")
  })
})

describe("formatHandoff", () => {
  test("includes the summary and touched files", () => {
    const text = formatHandoff("Alpha", "Refactored routing", ["src/router.ts", "src/app.ts"])
    expect(text).toContain("Alpha finished a step.")
    expect(text).toContain("Refactored routing")
    expect(text).toContain("src/router.ts")
  })

  test("is explicit when a step reported nothing", () => {
    expect(formatHandoff("Alpha", "   ", [])).toContain("(no summary provided)")
  })
})

describe("sharedFileConflicts", () => {
  test("names every holder of a contested file", () => {
    const conflicts = sharedFileConflicts([
      { id: "a", name: "Alpha", changedFiles: ["src/shared.ts", "src/a.ts"] },
      { id: "b", name: "Beta", changedFiles: ["src/shared.ts"] },
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.file).toBe("src/shared.ts")
    expect(conflicts[0]!.holders.map((h) => h.name).sort()).toEqual(["Alpha", "Beta"])
  })

  test("is quiet when no file is contested", () => {
    expect(sharedFileConflicts([{ id: "a", name: "A", changedFiles: ["x"] }, { id: "b", name: "B", changedFiles: ["y"] }])).toEqual([])
  })

  test("counts a duplicated path within one member only once", () => {
    expect(sharedFileConflicts([{ id: "a", name: "A", changedFiles: ["x", "x"] }])).toEqual([])
  })
})
