/**
 * The Subagent specialists that ship with Vector (packages/engine/src/agent/agent.ts). Settings → Agents has a switch
 * for each one, which writes `agent.<name>.disable`, and the engine and the app both read their names from here.
 */
export const NATIVE_SPECIALISTS = [
  "debug",
  "explore",
  "judge",
  "migration",
  "performance",
  "review",
  "security",
  "test",
] as const

export const isNativeSpecialist = (name: string) => (NATIVE_SPECIALISTS as readonly string[]).includes(name)
