// First-run onboarding progress. Two steps are detected live from app state
// (provider connected, project open); these persisted flags cover the actions
// that happen once and elsewhere (first task, first preview).

const STORAGE_KEY = "vector.onboarding.v1"
export const ONBOARDING_UPDATED_EVENT = "vector:onboarding-updated"

export type OnboardingFlags = {
  task?: boolean
  preview?: boolean
  /** The first-run tour was finished or skipped — never auto-open it again. */
  tour?: boolean
  dismissed?: boolean
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
