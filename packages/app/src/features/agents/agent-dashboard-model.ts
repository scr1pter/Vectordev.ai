// Derives the Agent Dashboard's view of every agent from the parallel
// workspace records the desktop main process already keeps. Pure so the
// grouping, health, and conflict rules can be tested without a renderer.

export type DashboardAgentStatus =
  | "queued"
  | "planning"
  | "editing"
  | "running commands"
  | "testing"
  | "complete"
  | "failed"
  | "needs review"
  | "stopped"
  | "merged"
  | "discarded"

export type DashboardAgentInput = {
  id: string
  name: string
  taskPrompt: string
  runtime: string
  provider: string
  model: string
  status: DashboardAgentStatus
  progress: number
  lastAction: string
  createdAt: string
  lastActivityAt: string
  changedFilesCount: number
  changedFiles: string[]
  estimatedCost: string
  actualCost?: string
  agent?: string
  swarmRunId?: string
  swarmRole?: "coordinator" | "worker"
  teamId?: string
  mergeState: "none" | "merged" | "discarded"
  error?: string
}

const RUNNING: DashboardAgentStatus[] = ["queued", "planning", "editing", "running commands", "testing"]
const FINISHED: DashboardAgentStatus[] = ["complete", "merged", "discarded", "stopped"]

export function isRunning(status: DashboardAgentStatus) {
  return RUNNING.includes(status)
}

export function isFinished(status: DashboardAgentStatus) {
  return FINISHED.includes(status)
}

export function needsAttention(agent: DashboardAgentInput) {
  return agent.status === "failed" || agent.status === "needs review" || Boolean(agent.error)
}

// Two agents "clash" when both still hold uncommitted work on the same file.
// Merged and discarded agents are excluded: their changes are already resolved,
// so reporting them would produce a permanent false alarm the user cannot clear.
export type AgentClash = {
  file: string
  agentIds: string[]
  agentNames: string[]
}

export function findClashes(agents: readonly DashboardAgentInput[]): AgentClash[] {
  const live = agents.filter((agent) => agent.mergeState === "none" && !isFinished(agent.status))
  const byFile = new Map<string, DashboardAgentInput[]>()
  for (const agent of live) {
    for (const file of new Set(agent.changedFiles)) {
      byFile.set(file, [...(byFile.get(file) ?? []), agent])
    }
  }
  return [...byFile.entries()]
    .filter(([, holders]) => holders.length > 1)
    .map(([file, holders]) => ({
      file,
      agentIds: holders.map((agent) => agent.id),
      agentNames: holders.map((agent) => agent.name),
    }))
    .sort((a, b) => a.file.localeCompare(b.file))
}

// A relayed message between two agents on the same team, as the dashboard
// renders it. Mirrors TeamMessage in the desktop main process; the app cannot
// import from packages/desktop, so the shape is restated here.
export type TeamConversationMessage = {
  id: string
  fromWorkspaceId: string
  fromName: string
  toWorkspaceId?: string
  text: string
  createdAt: string
}

export type TeamConversation = {
  teamId: string
  teamName: string
  messages: TeamConversationMessage[]
}

// Oldest first, so the exchange reads top-down like a transcript.
export function orderConversation(messages: readonly TeamConversationMessage[]) {
  return [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

// A handoff broadcast carries no recipient; a reply names one. Worth
// distinguishing so the transcript reads as a conversation rather than a log.
export function isDirected(message: TeamConversationMessage) {
  return Boolean(message.toWorkspaceId)
}

export type DashboardSummary = {
  total: number
  running: number
  attention: number
  finished: number
  changedFiles: number
  clashes: number
  teams: number
}

export function summarize(agents: readonly DashboardAgentInput[]): DashboardSummary {
  return {
    total: agents.length,
    running: agents.filter((agent) => isRunning(agent.status)).length,
    attention: agents.filter(needsAttention).length,
    finished: agents.filter((agent) => isFinished(agent.status)).length,
    changedFiles: new Set(agents.flatMap((agent) => agent.changedFiles)).size,
    clashes: findClashes(agents).length,
    teams: new Set(agents.map((agent) => agent.teamId).filter(Boolean)).size,
  }
}

// Agents in the same swarm run belong together; everything else is its own
// row. Coordinators sort ahead of their workers so a group reads top-down.
export type AgentGroup = {
  id: string
  label: string
  swarm: boolean
  agents: DashboardAgentInput[]
}

export function groupAgents(agents: readonly DashboardAgentInput[]): AgentGroup[] {
  const solo = agents.filter((agent) => !agent.swarmRunId)
  const swarms = new Map<string, DashboardAgentInput[]>()
  for (const agent of agents.filter((item) => item.swarmRunId)) {
    swarms.set(agent.swarmRunId!, [...(swarms.get(agent.swarmRunId!) ?? []), agent])
  }

  const swarmGroups = [...swarms.entries()].map(([id, members]) => ({
    id,
    label: members.find((member) => member.swarmRole === "coordinator")?.name ?? "Agent team",
    swarm: true,
    agents: [...members].sort((a, b) => {
      if (a.swarmRole === b.swarmRole) return a.name.localeCompare(b.name)
      return a.swarmRole === "coordinator" ? -1 : 1
    }),
  }))

  return [
    ...swarmGroups,
    ...solo.map((agent) => ({ id: agent.id, label: agent.name, swarm: false, agents: [agent] })),
  ]
}

// Live agents first, then those needing attention, then the rest — the
// dashboard should lead with what is still moving or still blocked.
export function sortForDisplay(agents: readonly DashboardAgentInput[]): DashboardAgentInput[] {
  const rank = (agent: DashboardAgentInput) => {
    if (isRunning(agent.status)) return 0
    if (needsAttention(agent)) return 1
    return 2
  }
  return [...agents].sort((a, b) => {
    const diff = rank(a) - rank(b)
    if (diff !== 0) return diff
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
  })
}

export function elapsedLabel(agent: DashboardAgentInput, now: number) {
  const started = Date.parse(agent.createdAt)
  if (!Number.isFinite(started)) return ""
  const end = isFinished(agent.status) ? Date.parse(agent.lastActivityAt) : now
  const seconds = Math.max(0, Math.round(((Number.isFinite(end) ? end : now) - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
