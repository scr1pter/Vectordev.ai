import { ExternalAgent } from "@vectordevai/schema/external-agent"
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
    ownership: agentOwnership(runtime),
  }
}

/** The line above an outside agent's conversation: the work is the user's own installed agent, not Vector's, and its
    vendor is not behind Vector. Undefined for Vector's own agent. */
export function agentOwnership(runtime: AgentRuntime) {
  if (runtime === "vector") return undefined
  const agent = ExternalAgent.find(runtime)
  if (!agent) return undefined
  return `This is your own ${agent.name} running in Vector, not a Vector agent. Vector is not affiliated with ${agent.vendor}.`
}
