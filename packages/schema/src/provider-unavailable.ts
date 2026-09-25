import { Schema } from "effect"

export const ProviderUnavailable = Schema.Struct({
  id: Schema.String,
  reason: Schema.Literals(["sign-in-paused", "provider-not-configured", "disabled", "no-models"]),
  message: Schema.String,
})
export type ProviderUnavailable = typeof ProviderUnavailable.Type

export function providerUnavailable(id: string, reason: ProviderUnavailable["reason"]): ProviderUnavailable {
  const action = {
    "sign-in-paused": "sign-in is paused in Vector; connect a supported provider with an API key",
    "provider-not-configured": "provider is not configured; add its endpoint and models to vector.json",
    disabled: "provider is disabled by your Vector configuration; enable it to use this credential",
    "no-models": "no usable models loaded; check the provider configuration and authentication",
  }[reason]
  return {
    id,
    reason,
    message: `${id}: ${action}, or run vector providers logout ${id} to remove the saved credential.`,
  }
}

export type ModelChoice = { providerID: string; modelID: string }

// Report only a preference that was actually skipped before the chosen model.
export function unavailableModel(
  candidates: ReadonlyArray<ModelChoice | undefined>,
  valid: (model: ModelChoice) => boolean,
) {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (valid(candidate)) return
    return candidate
  }
}

// One notice per cause per running client; revisiting a session does not repeat it.
export function providerNoticeTracker() {
  const seen = new Set<string>()
  return (scope: string, key: string) => {
    const id = JSON.stringify([scope, key])
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }
}
