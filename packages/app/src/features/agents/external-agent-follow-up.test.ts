import { describe, expect, test } from "bun:test"
import { externalAgentFollowUpDraft, withExternalAgentFollowUpDraft } from "./external-agent-follow-up"

describe("external agent follow-up drafts", () => {
  test("keeps a different draft for every workspace", () => {
    const first = withExternalAgentFollowUpDraft({}, "claude", "fix the tests")
    const second = withExternalAgentFollowUpDraft(first, "codex", "review the diff")

    expect(externalAgentFollowUpDraft(second, "claude")).toBe("fix the tests")
    expect(externalAgentFollowUpDraft(second, "codex")).toBe("review the diff")
    expect(externalAgentFollowUpDraft(second, "cursor")).toBe("")
  })

  test("updating one workspace does not mutate the previous state", () => {
    const before = { claude: "one", codex: "two" }
    const after = withExternalAgentFollowUpDraft(before, "claude", "updated")

    expect(before.claude).toBe("one")
    expect(after).toEqual({ claude: "updated", codex: "two" })
  })
})
