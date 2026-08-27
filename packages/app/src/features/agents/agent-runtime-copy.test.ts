import { describe, expect, test } from "bun:test"
import { agentReviewCopy, agentRuntimeLabel, type AgentRuntime } from "./agent-runtime-copy"

const runtimes = [
  { runtime: "vector", label: "Vector" },
  { runtime: "claude-code", label: "Claude Code" },
  { runtime: "codex", label: "Codex" },
  { runtime: "cursor", label: "Cursor Agent" },
] satisfies { runtime: AgentRuntime; label: string }[]

describe("agent runtime review copy", () => {
  test("labels every supported run from its runtime", () => {
    runtimes.forEach((entry) => {
      expect(agentRuntimeLabel(entry.runtime)).toBe(entry.label)
    })
  })

  test("uses the run runtime in transcript, activity, follow-up, and control copy", () => {
    runtimes.forEach((entry) => {
      const copy = agentReviewCopy(entry.runtime, { running: false, resumable: true })
      expect(copy.label).toBe(entry.label)
      expect(copy.activityLabel).toBe(`${entry.label} activity`)
      expect(copy.followUpPlaceholder).toBe(`Tell ${entry.label} what to do next…`)
      expect(copy.followUpAriaLabel).toBe(`Follow up with ${entry.label}`)
      expect(copy.followUpHelp).toBe(`Continues the same ${entry.label} conversation.`)
      expect(copy.sendFollowUpAriaLabel).toBe(`Send follow-up to ${entry.label}`)
      expect(copy.refreshActivityLabel).toBe(`Refresh ${entry.label} activity`)
      expect(copy.stopLabel).toBe(`Stop ${entry.label}`)
    })
  })

  test("names the runtime in running and restarted-conversation help", () => {
    expect(agentReviewCopy("codex", { running: true, resumable: true }).followUpHelp).toBe(
      "Codex is working. Wait for it to finish, or stop it.",
    )
    expect(agentReviewCopy("claude-code", { running: false, resumable: false }).followUpHelp).toBe(
      "Vector couldn't save Claude Code's conversation, so your next message restarts it with a written summary of the work so far.",
    )
    expect(agentReviewCopy("cursor", { running: false, resumable: false }).followUpHelp).toContain(
      "Cursor Agent's conversation",
    )
  })
})
