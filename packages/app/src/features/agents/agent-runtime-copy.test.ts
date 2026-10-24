import { describe, expect, test } from "bun:test"
import { agentOwnership, agentReviewCopy, agentRuntimeLabel, type AgentRuntime } from "./agent-runtime-copy"

const runtimes = [
  { runtime: "vector", label: "Vector" },
  { runtime: "claude-code", label: "Claude Code" },
  { runtime: "codex", label: "Codex" },
  { runtime: "cursor", label: "Cursor CLI" },
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
      "Cursor CLI's conversation",
    )
  })

  test("an outside agent's conversation says it is the user's own agent, not Vector's, and not its vendor's product", () => {
    expect(agentOwnership("codex")).toBe(
      "This is your own Codex running in Vector, not a Vector agent. Vector is not affiliated with OpenAI.",
    )
    expect(agentReviewCopy("claude-code", { running: false, resumable: true }).ownership).toBe(
      "This is your own Claude Code running in Vector, not a Vector agent. Vector is not affiliated with Anthropic.",
    )
    expect(agentOwnership("cursor")).toContain("your own Cursor CLI")
    expect(agentOwnership("cursor")).toContain("Anysphere")
    // Vector's own agent needs no such line.
    expect(agentOwnership("vector")).toBeUndefined()
    expect(agentReviewCopy("vector", { running: false, resumable: true }).ownership).toBeUndefined()
  })
})
