import { randomUUID } from "node:crypto"

import { getStore } from "./store"
import {
  appendMessage,
  markDelivered,
  pendingFor,
  type AgentTeam,
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
      messages: Array.isArray(team.messages)
        ? team.messages.map((message) => ({
            ...message,
            deliveredTo: Array.isArray(message.deliveredTo) ? message.deliveredTo : [],
          }))
        : [],
    }))
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

export function addTeamMember(teamId: string, workspaceId: string) {
  return updateTeam(teamId, (team) =>
    team.memberIds.includes(workspaceId) ? team : { ...team, memberIds: [...team.memberIds, workspaceId] },
  )
}

export function removeTeamMember(teamId: string, workspaceId: string) {
  return updateTeam(teamId, (team) => ({ ...team, memberIds: team.memberIds.filter((id) => id !== workspaceId) }))
}

export function postTeamMessage(input: {
  teamId: string
  fromWorkspaceId: string
  fromName: string
  toWorkspaceId?: string
  text: string
}) {
  const text = input.text.trim()
  if (!text) return undefined
  const message: TeamMessage = {
    id: randomUUID(),
    teamId: input.teamId,
    fromWorkspaceId: input.fromWorkspaceId,
    fromName: input.fromName,
    toWorkspaceId: input.toWorkspaceId,
    text,
    createdAt: now(),
    deliveredTo: [],
  }
  return updateTeam(input.teamId, (team) => appendMessage(team, message))
}

// Claims a member's pending messages and marks them delivered in one step, so
// two concurrent drains cannot hand the same message to an agent twice.
export function claimPendingMessages(teamId: string, workspaceId: string) {
  const team = getAgentTeam(teamId)
  if (!team) return []
  const pending = pendingFor(team, workspaceId)
  if (!pending.length) return []
  updateTeam(teamId, (current) => markDelivered(current, workspaceId, pending.map((message) => message.id)))
  return pending
}

export function deleteAgentTeam(teamId: string) {
  writeTeams(readTeams().filter((team) => team.id !== teamId))
}
