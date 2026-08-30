import { describe, expect, test } from "bun:test"
import {
  externalAgentFollowUpDraft,
  externalAgentFollowUpSubmission,
  restoreExternalAgentFollowUpDraft,
  withExternalAgentFollowUpDraft,
} from "./external-agent-follow-up"

describe("external agent follow-up drafts", () => {
  test("submission refuses active runs, pending sends and whitespace without consuming the draft", () => {
    expect(externalAgentFollowUpSubmission({ draft: "next", running: true, sending: false })).toBeUndefined()
    expect(externalAgentFollowUpSubmission({ draft: "next", running: false, sending: true })).toBeUndefined()
    expect(externalAgentFollowUpSubmission({ draft: " \n", running: false, sending: false })).toBeUndefined()
    expect(externalAgentFollowUpSubmission({ draft: " next ", running: false, sending: false })).toBe("next")
  })

  test("a failed send restores the submitted text without replacing a newly typed draft", () => {
    const drafts = { claude: "new draft", codex: "unrelated" }
    expect(restoreExternalAgentFollowUpDraft(drafts, "claude", "submitted")).toEqual({
      claude: "submitted\n\nnew draft",
      codex: "unrelated",
    })
    expect(drafts.claude).toBe("new draft")
    expect(restoreExternalAgentFollowUpDraft({ claude: "" }, "claude", "submitted")).toEqual({ claude: "submitted" })
    expect(restoreExternalAgentFollowUpDraft({}, "cursor", "submitted")).toEqual({ cursor: "submitted" })
  })
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
