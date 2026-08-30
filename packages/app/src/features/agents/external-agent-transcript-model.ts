export type ExternalAgentTurn = {
  id: string
  role: "user" | "agent" | "vector"
  text: string
  at: string
  state: "running" | "done" | "failed" | "stopped"
  resumed?: boolean
  cost?: string
  streamTail?: string[]
  messages?: { id: string; text: string }[]
  activity?: {
    id: string
    label: string
    kind: "tool" | "thinking"
    state: "running" | "done" | "failed"
  }[]
}

export function restartedConversation(turns: readonly ExternalAgentTurn[], index: number) {
  const turn = turns[index]
  if (turn?.role !== "agent" || turn.resumed !== false) return false
  // The first response starts a conversation; only a follow-up can fail resume.
  return turns.slice(0, index).some((entry) => entry.role === "agent")
}

export function externalAgentMessages(turn: ExternalAgentTurn) {
  const messages = turn.messages?.filter((message) => message.text.trim())
  if (messages?.length) return messages
  return turn.text.trim() ? [{ id: `${turn.id}:reply`, text: turn.text }] : []
}
