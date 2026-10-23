import { Schema } from "effect"
import { providerAllowed, renamedModel } from "./provider-policy"

export const ProviderUnavailable = Schema.Struct({
  id: Schema.String,
  reason: Schema.Literals(["sign-in-paused", "provider-not-configured", "disabled", "no-models", "off-in-local"]),
  message: Schema.String,
})
export type ProviderUnavailable = typeof ProviderUnavailable.Type

/**
 * Why Vector Local keeps a model off, and what makes it usable, after "<provider>: off in Vector Local." The engine's
 * provider list and the V2 runner both say these.
 */
export const OFF_IN_LOCAL = {
  listed:
    "Its server is not on your list of model servers. Add the server to the list, or turn Vector Local off to use it.",
  vector:
    "Vector's free models and Vector Codium run on vectordev.ai, outside the model servers you host. Turn Vector Local off to use them.",
  ollama:
    "It is an Ollama cloud model: the Ollama app passes its prompts on to ollama.com. Choose a model that runs on your server, or turn Vector Local off to use it.",
  unknown:
    "Vector cannot tell which server its requests go to. Set its baseURL to a model server on your list, or turn Vector Local off to use it.",
  cloud: (origin: string) =>
    `${origin} is a cloud AI service, not a server you host. Your company's policy can list it, or turn Vector Local off to use it.`,
}

export function providerUnavailable(id: string, reason: ProviderUnavailable["reason"]): ProviderUnavailable {
  // Vector Local keeps the credential: removing it would not make the provider usable, so the logout advice that ends
  // the other messages does not apply.
  if (reason === "off-in-local") return { id, reason, message: `${id}: off in Vector Local. ${OFF_IN_LOCAL.listed}` }
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

// A provider this Vector no longer offers: outside the supported set and declared nowhere, neither in
// configuration nor by a plugin. Saved choices from earlier versions can still name one; they fall back
// silently. A declared provider that failed to load is not retired, so its choices keep their notice or
// error rather than quietly moving the conversation to another provider.
export function providerRetired(id: string, declared: (id: string) => boolean) {
  return !providerAllowed(id) && !declared(id)
}

// Report only a preference that was actually skipped before the chosen model. A preference under a
// renamed provider is judged by its new ID, and one for a retired provider is skipped without a report.
export function unavailableModel(
  candidates: ReadonlyArray<ModelChoice | undefined>,
  valid: (model: ModelChoice) => boolean,
  declared: (providerID: string) => boolean,
) {
  for (const candidate of candidates) {
    if (!candidate) continue
    const current = renamedModel(candidate)
    if (providerRetired(current.providerID, declared)) continue
    if (valid(current)) return
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
