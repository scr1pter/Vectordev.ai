export type ExternalAgentActivity = {
  id: string
  label: string
  kind: "tool" | "thinking"
  state: "running" | "done" | "failed"
  // Paths relative to the agent's workspace that an edit or write call names.
  // Desktop never sends file contents here.
  files?: string[]
}

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
  activity?: ExternalAgentActivity[]
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

// What a running turn is doing now: the newest step still in progress, which
// is "thinking" when that step is a reasoning phase rather than a tool call.
export function externalAgentProgress(turn: ExternalAgentTurn) {
  const running = turn.activity?.findLast((entry) => entry.state === "running")
  return { thinking: running?.kind === "thinking", label: running?.label }
}

// "8s", "1m 05s", or "1h 02m" since `fromIso`; empty when the time is unreadable.
export function elapsedLabel(fromIso: string, now: number) {
  const from = Date.parse(fromIso)
  if (!Number.isFinite(from) || !Number.isFinite(now)) return ""
  const seconds = Math.max(0, Math.floor((now - from) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}
