import { externalRuntimeSetup, type ExternalRuntime } from "./external-runtimes"

export type AgentRuntime = "vector" | ExternalRuntime

export function agentRuntimeLabel(runtime: AgentRuntime) {
  if (runtime === "vector") return "Vector"
  return externalRuntimeSetup(runtime)?.label ?? "Vector"
}

export function agentReviewCopy(runtime: AgentRuntime, state: { running: boolean; resumable: boolean }) {
  const label = agentRuntimeLabel(runtime)
  const help = state.running
    ? `${label} is working. Wait for it to finish, or stop it.`
    : state.resumable
      ? `Continues the same ${label} conversation.`
      : `Vector couldn't save ${label}'s conversation, so your next message restarts it with a written summary of the work so far.`

  return {
    label,
    activityLabel: `${label} activity`,
    followUpPlaceholder: `Tell ${label} what to do next…`,
    followUpAriaLabel: `Follow up with ${label}`,
    followUpHelp: help,
    sendFollowUpAriaLabel: `Send follow-up to ${label}`,
    refreshActivityLabel: `Refresh ${label} activity`,
    stopLabel: `Stop ${label}`,
  }
}
