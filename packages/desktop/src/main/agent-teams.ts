import { randomUUID } from "node:crypto"

import { getStore } from "./store"
import {
  appendMessage,
  effectiveCollaborationGraph,
  markDelivered,
  pendingFor,
  pruneCollaborationGraph,
  recipientsFor,
  routeMessage,
  validateCollaborationGraph,
  ROUTER_NAME,
  ROUTER_WORKSPACE_ID,
  type AgentTeam,
  type TeamCollaborationGraph,
  type TeamLink,
  type TeamMessage,
  type TeamTopology,
} from "./agent-team-model"

// Persistence and relay for agent teams. The pure routing rules live in
// agent-team-model; this file owns the store and the engine call that actually
// hands a teammate's message to another agent.

const STORE_NAME = "agent-teams-state"
const STORE_KEY = "teams"

const now = () => new Date().toISOString()

function readTeams(): AgentTeam[] {
  const raw = getStore(STORE_NAME).get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is AgentTeam => Boolean(item) && typeof item === "object" && typeof item.id === "string")
    .map((team) => ({
      ...team,
      memberIds: Array.isArray(team.memberIds) ? team.memberIds : [],
      collaboration: readGraph(team.collaboration),
      messages: Array.isArray(team.messages)
        ? team.messages.map((message) => ({
            ...message,
            deliveredTo: Array.isArray(message.deliveredTo) ? message.deliveredTo : [],
          }))
        : [],
    }))
}

// A team stored before selective pairing has no `collaboration` key and must
// stay that way: `undefined` is the all-to-all default, while `{ links: [] }`
// is a deliberate "nobody may talk" the user chose. Malformed data therefore
// degrades to the default rather than to silence — a bad read that muted a
// running team would look exactly like the agents having nothing to say.
function readGraph(value: unknown): TeamCollaborationGraph | undefined {
  const links = (value as { links?: unknown } | null | undefined)?.links
  if (!Array.isArray(links)) return undefined
  return {
    links: links.flatMap((entry) => {
      const link = entry as Partial<TeamLink> | null
      if (typeof link?.from !== "string" || typeof link.to !== "string") return []
      return [{ from: link.from, to: link.to, mutual: link.mutual === true }]
    }),
  }
}

function writeTeams(teams: AgentTeam[]) {
  getStore(STORE_NAME).set(STORE_KEY, teams)
}

function updateTeam(id: string, mutate: (team: AgentTeam) => AgentTeam) {
  const teams = readTeams()
  const index = teams.findIndex((team) => team.id === id)
  if (index < 0) return undefined
  const next = mutate(teams[index]!)
  teams[index] = next
  writeTeams(teams)
  return next
}

export function listAgentTeams(scope?: { sourcePath?: string; parentSessionId?: string }) {
  return readTeams().filter((team) => {
    if (scope?.sourcePath && team.sourcePath !== scope.sourcePath) return false
    if (scope?.parentSessionId && team.parentSessionId !== scope.parentSessionId) return false
    return true
  })
}

export function getAgentTeam(id: string) {
  return readTeams().find((team) => team.id === id)
}

export function teamForWorkspace(workspaceId: string) {
  return readTeams().find((team) => team.memberIds.includes(workspaceId))
}

export function createAgentTeam(input: {
  name: string
  topology: TeamTopology
  sourcePath: string
  parentSessionId?: string
  sharedPath?: string
}): AgentTeam {
  const team: AgentTeam = {
    id: randomUUID(),
    name: input.name.trim() || "Agent team",
    topology: input.topology,
    sourcePath: input.sourcePath,
    parentSessionId: input.parentSessionId,
    sharedPath: input.sharedPath,
    memberIds: [],
    createdAt: now(),
    messages: [],
  }
  writeTeams([...readTeams(), team])
  return team
}

// A member joining a team that has an explicit graph starts with no links, and
// so can neither message nor be messaged until the user pairs it. Auto-linking
// it to everyone would quietly undo the pairing the user configured; the new
// member instead gets an actionable refusal the first time it tries to speak.
export function addTeamMember(teamId: string, workspaceId: string) {
  return updateTeam(teamId, (team) =>
    team.memberIds.includes(workspaceId) ? team : { ...team, memberIds: [...team.memberIds, workspaceId] },
  )
}

export function removeTeamMember(teamId: string, workspaceId: string) {
  return updateTeam(teamId, (team) => {
    const memberIds = team.memberIds.filter((id) => id !== workspaceId)
    return { ...team, memberIds, collaboration: pruneCollaborationGraph(team.collaboration, memberIds) }
  })
}

// `explicit` tells a UI whether it is looking at a stored graph or at the
// all-to-all default rendered for editing. Saving the returned graph unchanged
// pins today's behaviour in place, which is the honest result of a user opening
// the pairing editor and pressing save.
export function getCollaborationGraph(teamId: string) {
  const team = getAgentTeam(teamId)
  if (!team) return undefined
  return { explicit: Boolean(team.collaboration), graph: effectiveCollaborationGraph(team) }
}

// Pass `undefined` to clear the graph and return the team to all-to-all.
// Pass `{ links: [] }` to make every member work alone.
export function setCollaborationGraph(teamId: string, graph: TeamCollaborationGraph | undefined) {
  const team = getAgentTeam(teamId)
  if (!team) return { ok: false as const, errors: ["That team no longer exists."] }
  const errors = graph ? validateCollaborationGraph(team.memberIds, graph) : []
  if (errors.length) return { ok: false as const, errors }
  return { ok: true as const, errors, team: updateTeam(teamId, (current) => ({ ...current, collaboration: graph })) }
}

export function postTeamMessage(input: {
  messageId?: string
  teamId: string
  fromWorkspaceId: string
  fromName: string
  toWorkspaceId?: string
  text: string
  memberNames?: Record<string, string>
}) {
  const text = input.text.trim()
  if (!text)
    return { ok: false as const, reason: "Message not delivered: the message body was empty.", allowedRecipients: [] }
  const team = getAgentTeam(input.teamId)
  if (!team)
    return { ok: false as const, reason: "Message not delivered: that team no longer exists.", allowedRecipients: [] }
  const existing = input.messageId ? team.messages.find((message) => message.id === input.messageId) : undefined
  if (existing) {
    const recipients = existing.toWorkspaceId ? [existing.toWorkspaceId] : recipientsFor(team, existing.fromWorkspaceId)
    return { ok: true as const, recipients, team }
  }

  const routing = routeMessage(team, {
    fromWorkspaceId: input.fromWorkspaceId,
    toWorkspaceId: input.toWorkspaceId,
    memberNames: input.memberNames,
  })
  // A refused message addressed to a named teammate is bounced back to its
  // sender instead of dropped. The send tool runs in the engine sidecar and has
  // already returned "queued" by the time routing happens, so this notice is
  // the only way the agent learns that nobody received the work it delegated.
  //
  // A refused broadcast is not bounced: broadcasts include the per-step handoff
  // the orchestrator sends on the agent's behalf, and a notice on every step
  // would crowd out the agent's own task with news it cannot act on. Callers
  // get `reason` back and should surface that to the user instead.
  if (!routing.ok)
    return {
      ok: false as const,
      reason: routing.reason,
      allowedRecipients: routing.allowedRecipients,
      team:
        input.toWorkspaceId && team.memberIds.includes(input.fromWorkspaceId)
          ? updateTeam(team.id, (current) =>
              appendMessage(current, {
                id: input.messageId ? `${input.messageId}:bounce` : randomUUID(),
                teamId: team.id,
                fromWorkspaceId: ROUTER_WORKSPACE_ID,
                fromName: ROUTER_NAME,
                toWorkspaceId: input.fromWorkspaceId,
                // Echo enough of the original for the agent to recognise which
                // send failed, but not a whole pasted diff back into its prompt.
                text: `${routing.reason}\n\nThe message you tried to send began:\n${text.slice(0, 800)}`,
                createdAt: now(),
                deliveredTo: [],
              }),
            )
          : undefined,
    }

  const message: TeamMessage = {
    id: input.messageId ?? randomUUID(),
    teamId: input.teamId,
    fromWorkspaceId: input.fromWorkspaceId,
    fromName: input.fromName,
    toWorkspaceId: input.toWorkspaceId,
    text,
    createdAt: now(),
    deliveredTo: [],
  }
  return {
    ok: true as const,
    recipients: routing.recipients,
    team: updateTeam(input.teamId, (current) => appendMessage(current, message)),
  }
}

// Claims a member's pending messages and marks them delivered in one step, so
// two concurrent drains cannot hand the same message to an agent twice.
export function claimPendingMessages(teamId: string, workspaceId: string) {
  const team = getAgentTeam(teamId)
  if (!team) return []
  const pending = pendingFor(team, workspaceId)
  if (!pending.length) return []
  updateTeam(teamId, (current) =>
    markDelivered(
      current,
      workspaceId,
      pending.map((message) => message.id),
    ),
  )
  return pending
}

export function pendingTeamMessages(teamId: string, workspaceId: string) {
  const team = getAgentTeam(teamId)
  return team ? pendingFor(team, workspaceId) : []
}

export function markTeamMessagesDelivered(teamId: string, workspaceId: string, messageIds: readonly string[]) {
  return updateTeam(teamId, (team) => markDelivered(team, workspaceId, messageIds))
}

export function deleteAgentTeam(teamId: string) {
  writeTeams(readTeams().filter((team) => team.id !== teamId))
}
