export type ParallelWorkspaceTurn = {
  id: string
  // "vector" is Vector's own narration — repair notices, rebuild notices — and
  // renders as a quiet system line rather than as either side of the chat.
  role: "user" | "agent" | "vector"
  text: string
  at: string
  state: "running" | "done" | "failed" | "stopped"
  // False when Vector had no session id and had to re-brief instead of
  // resuming. The UI says so rather than pretending the agent remembers.
  resumed?: boolean
  cost?: string
  // Live output for the turn in flight, dropped when the turn settles so a
  // finished conversation does not carry its whole scrollback in the store.
  streamTail?: string[]
}

const TURN_LIMIT = 120
const STREAM_TAIL_LIMIT = 40

export function appendTurn(turns: ParallelWorkspaceTurn[] | undefined, turn: ParallelWorkspaceTurn) {
  return [...(turns ?? []), turn].slice(-TURN_LIMIT)
}

export function extendStreamTail(turns: ParallelWorkspaceTurn[] | undefined, id: string, lines: string[]) {
  return (turns ?? []).map((turn) =>
    turn.id === id ? { ...turn, streamTail: [...(turn.streamTail ?? []), ...lines].slice(-STREAM_TAIL_LIMIT) } : turn,
  )
}

export function settleTurn(
  turns: ParallelWorkspaceTurn[] | undefined,
  id: string,
  patch: { text?: string; state: ParallelWorkspaceTurn["state"]; cost?: string },
) {
  return (turns ?? []).map((turn) =>
    turn.id === id ? { ...turn, ...patch, text: patch.text ?? turn.text, streamTail: undefined } : turn,
  )
}

// Every exit that is not a clean settle — the catch in executeParallelWorkspace,
// and the restart sweep in listParallelWorkspaces — closes whatever was still
// open, or the transcript keeps a spinner forever.
export function settleRunningTurns(
  turns: ParallelWorkspaceTurn[] | undefined,
  patch: { text: string; state: ParallelWorkspaceTurn["state"] },
) {
  return (turns ?? []).map((turn) =>
    turn.state === "running"
      ? { ...turn, state: patch.state, text: turn.text || patch.text, streamTail: undefined }
      : turn,
  )
}

// The follow-up prompt for when there is no session id to resume. The agent has
// no memory of the previous turn, so the changed-file list is the only proof
// that work already happened — without it the agent redoes the whole mission.
export function continuationPrompt(input: {
  missionBrief: string
  previousSummary: string
  changedFiles: string[]
  instruction: string
}) {
  return [
    input.missionBrief,
    "",
    "[vector:continuation]",
    "This is a follow-up turn. The previous conversation could not be restored, so the notes below are the only record of what already happened in this workspace. Read the current files before changing anything.",
    input.previousSummary ? `The previous turn reported:\n${input.previousSummary}` : "",
    input.changedFiles.length
      ? `Files already changed here — do not redo this work:\n${input.changedFiles.map((file) => `- ${file}`).join("\n")}`
      : "No files have been changed in this workspace yet.",
    "",
    `New instruction: ${input.instruction}`,
  ]
    .filter(Boolean)
    .join("\n")
}
