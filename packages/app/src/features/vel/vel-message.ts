export const VEL_VOICE_TURN_MARKER = "[vector:vel-voice-turn]"
export const VEL_OPEN_EVENT = "vector:vel-open"

export const VEL_VOICE_SYSTEM = [
  VEL_VOICE_TURN_MARKER,
  "This request was spoken through Vel inside the user's currently selected Vector session.",
  "Treat the spoken request exactly like a typed request: inspect the project, use tools, edit files, run commands, test, or delegate when needed.",
  "Do not merely describe work the user asked you to perform. Perform it when the available tools and permissions allow it.",
  "Do not mention handoffs, transcription, or a separate voice assistant. You are the active agent for this session.",
  "Write a concise but complete spoken-friendly final response because the same response will be shown in chat and read aloud.",
  "Never claim that an action succeeded unless it actually completed.",
].join("\n")

export function isVelVoiceTurn(system: string | undefined) {
  return system?.includes(VEL_VOICE_TURN_MARKER) ?? false
}

export function requestVelCall() {
  globalThis.window?.dispatchEvent(new CustomEvent(VEL_OPEN_EVENT))
}
