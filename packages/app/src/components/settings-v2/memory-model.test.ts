import { describe, expect, test } from "bun:test"
import {
  MEMORY_TABS,
  approvable,
  editable,
  fileLabel,
  forgettable,
  holdLabel,
  kindLabel,
  originLabel,
  pinnable,
  rejectable,
  savedNotice,
  summary,
  UNDONE,
  usage,
} from "./memory-model"

const files = {
  memory: "/Users/a/.config/vector/MEMORY.md",
  rules: "/Users/a/.config/vector/RULES.md",
  repository: ["/repo/.vector/RULES.md"],
}

describe("memory page model", () => {
  test("says where each entry comes from", () => {
    expect(originLabel({ origin: "agent", scope: "repository" })).toBe("Vector learned this")
    expect(originLabel({ origin: "user", scope: "personal" })).toBe("You added this")
    expect(originLabel({ origin: "failure-memory", scope: "repository" })).toBe("Failure memory from checks Vector ran")
    expect(originLabel({ origin: "file", scope: "personal", source: { file: files.memory } }, files)).toBe(
      "From your MEMORY.md",
    )
    expect(originLabel({ origin: "file", scope: "personal", source: { file: files.rules } }, files)).toBe(
      "From your RULES.md",
    )
    expect(
      originLabel({ origin: "file", scope: "repository", source: { file: "/repo/.vector/RULES.md" } }, files),
    ).toBe("From the repository's .vector/RULES.md")
    expect(originLabel({ origin: "file", scope: "repository", source: { file: "/repo/BRAIN.md" } }, files)).toBe(
      "From the repository's BRAIN.md (read-only)",
    )
  })

  test("only lets the page change what Vector or the user saved, and files stay theirs", () => {
    expect(editable({ origin: "agent" })).toBe(true)
    expect(editable({ origin: "user" })).toBe(true)
    expect(editable({ origin: "file" })).toBe(false)
    expect(editable({ origin: "failure-memory" })).toBe(false)
    expect(forgettable({ origin: "file" })).toBe(false)
    expect(forgettable({ origin: "failure-memory" })).toBe(true)
  })

  test("names files the short way and pins only what pinning changes", () => {
    expect(fileLabel(files.memory, files, "/repo")).toBe("your MEMORY.md")
    expect(fileLabel("/repo/.vector/RULES.md", files, "/repo")).toBe(".vector/RULES.md")
    expect(fileLabel("/elsewhere/BRAIN.md", files, "/repo")).toBe("BRAIN.md")
    expect(pinnable({ kind: "rule", status: "active" })).toBe(false)
    expect(pinnable({ kind: "review", status: "active" })).toBe(false)
    expect(pinnable({ kind: "lesson", status: "active" })).toBe(true)
    expect(pinnable({ kind: "lesson", status: "quarantined" })).toBe(false)
  })

  test("offers approval only where approving can work", () => {
    expect(approvable({ status: "quarantined", origin: "agent", hold: "web" })).toBe(true)
    expect(approvable({ status: "proposed", origin: "agent" })).toBe(true)
    expect(approvable({ status: "active", origin: "agent" })).toBe(false)
    // A repository's memory waits on trusting the repository, and hidden characters on fixing the file.
    expect(approvable({ status: "quarantined", origin: "file", hold: "untrusted-repository" })).toBe(false)
    expect(approvable({ status: "quarantined", origin: "file", hold: "hidden-unicode" })).toBe(false)
    expect(approvable({ status: "quarantined", origin: "file", hold: "instruction-like" })).toBe(true)
    expect(rejectable({ status: "quarantined", origin: "file" })).toBe(false)
    expect(rejectable({ status: "quarantined", origin: "agent" })).toBe(true)
  })

  test("explains every reason memory waits", () => {
    for (const hold of [
      "web",
      "mcp",
      "subagent",
      "untrusted-repository",
      "guest",
      "instruction-like",
      "hidden-unicode",
      "hidden-text",
      "suggested",
      undefined,
    ] as const)
      expect(holdLabel(hold).length).toBeGreaterThan(20)
    // Only an earlier version left proposals, and they wait for the user; a fetching command holds memory like the web.
    expect(holdLabel(undefined)).toContain("An earlier version")
    expect(holdLabel(undefined)).toContain("once you approve it")
    expect(holdLabel(undefined)).not.toContain("later session")
    expect(holdLabel("web")).toContain("reaches outside this computer")
    expect(holdLabel("mcp")).toContain("an MCP server's prompt")
    expect(kindLabel("failure")).toBe("Past failure")
  })

  test("sums up memory and its cost in plain words", () => {
    expect(summary({ active: 12, review: 2, archived: 0, digestTokens: 148 })).toBe(
      "12 in use · 2 to review · about 148 tokens in every request",
    )
    expect(summary({ active: 0, review: 0, archived: 0, digestTokens: 0 })).toBe(
      "0 in use · nothing added to requests until there is memory",
    )
    const now = Date.UTC(2026, 9, 18)
    expect(usage({ uses: 0 }, now)).toBe("Not used yet")
    expect(usage({ uses: 3, lastUsedAt: now - 2 * 86_400_000 }, now)).toBe("Used 3 times, last 2 days ago")
  })

  test("never says project", () => {
    const strings = [
      ...[
        "web",
        "mcp",
        "subagent",
        "untrusted-repository",
        "guest",
        "instruction-like",
        "hidden-unicode",
        "hidden-text",
        "suggested",
      ].map((hold) => holdLabel(hold as never)),
      UNDONE,
      summary({ active: 1, review: 1, archived: 1, digestTokens: 1 }),
      originLabel({ origin: "file", scope: "repository", source: { file: "/repo/BRAIN.md" } }),
    ]
    for (const text of strings) expect(text.toLowerCase()).not.toContain("project")
  })

  test("after Undo, says Vector will not learn it again and where to bring it back", () => {
    expect(UNDONE).toContain("will not learn it again")
    expect(UNDONE).toContain("restore it from Archived")
  })

  test("after adding, says what the engine kept rather than what was typed", () => {
    const now = 1_760_000_000_000
    expect(savedNotice({ text: "Use pnpm.", status: "active", createdAt: now, updatedAt: now }, "Use pnpm.")).toBe(
      "Saved. Vector will use it when it is relevant.",
    )
    expect(
      savedNotice({ text: "Use pnpm.", status: "active", createdAt: now - 86_400_000, updatedAt: now }, "use pnpm"),
    ).toBe('This was already in memory, and it is in use: "Use pnpm."')
    expect(
      savedNotice(
        { text: "Deploy key is [redacted].", status: "active", createdAt: now, updatedAt: now },
        "Deploy key is ghp_x",
      ),
    ).toBe("Saved without the secret it contained. Vector will use it when it is relevant.")
  })

  test("splits the page into Memory, Documents and Research", () => {
    expect(MEMORY_TABS.map((item) => item.label)).toEqual(["Memory", "Documents", "Research", "Search model"])
    for (const item of MEMORY_TABS) expect(item.label.toLowerCase()).not.toContain("project")
  })
})
