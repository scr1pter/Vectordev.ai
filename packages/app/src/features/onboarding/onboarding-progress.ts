// First-run activation progress. Project state is detected live; these flags
// cover actions that require durable evidence from a completed provider turn.

const STORAGE_KEY = "vector.onboarding.v1"
export const ONBOARDING_UPDATED_EVENT = "vector:onboarding-updated"

export type OnboardingFlags = {
  /** At least one provider/model turn completed without an assistant error. */
  providerVerified?: boolean
  /** At least one real user prompt reached a successfully completed assistant turn. */
  taskCompleted?: boolean
  preview?: boolean
  /** The first-run tour was finished or skipped — never auto-open it again. */
  tour?: boolean
  dismissed?: boolean
}

type ActivationMessage = {
  info?: {
    role?: string
    providerID?: string
    modelID?: string
    error?: unknown
    finish?: string
    summary?: unknown
    time?: { created?: number; completed?: number }
    tokens?: { output?: number }
  }
  parts?: { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }[]
}

export function successfulActivationFromSession(messages: ActivationMessage[]) {
  const lastUserPrompt = messages.reduce((latest, message, index) => {
    if (message.info?.role !== "user") return latest
    const hasPrompt = message.parts?.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && Boolean(part.text?.trim()),
    )
    return hasPrompt ? index : latest
  }, -1)
  if (lastUserPrompt === -1) return false

  const finalResponse = messages
    .slice(lastUserPrompt + 1)
    .filter((message) => message.info?.role === "assistant")
    .at(-1)
  const info = finalResponse?.info
  if (!info || info.error || info.summary === true) return false
  if (!info.providerID?.trim() || !info.modelID?.trim()) return false
  if (typeof info.time?.completed !== "number") return false
  if (info.finish !== "stop" && info.finish !== "end_turn") return false
  return (
    finalResponse.parts?.some(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && Boolean(part.text?.trim()),
    ) ?? false
  )
}

export function readOnboardingFlags(): OnboardingFlags {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as OnboardingFlags) : {}
  } catch {
    return {}
  }
}

export function setOnboardingFlag(flag: keyof OnboardingFlags, value = true) {
  try {
    const current = readOnboardingFlags()
    if (current[flag] === value) return
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ ...current, [flag]: value }))
    globalThis.window?.dispatchEvent(new CustomEvent(ONBOARDING_UPDATED_EVENT))
  } catch {
    // Progress tracking is a convenience; never let it break a real action.
  }
}
