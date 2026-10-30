import { CodiumPlan } from "../../packages/schema/src/codium-plan.js"
import { CODIUM_MODELS, CODIUM_TIER_MODELS } from "./codium-catalog.js"
import { configuredPlanModels, type ModelPlanModel } from "./model-plan-config.js"
import { CAPTURED_RESERVATIONS, RESERVATION_CAPTURE, ROUTE_ACCEPTANCES } from "./codium-reservations.js"

/** Apply approved access tiers to the verified active catalog without activating the staged routes or larger windows. */
export function gatewayPlanModels(): readonly ModelPlanModel[] {
  return configuredPlanModels().map((model) => {
    const policy = CODIUM_TIER_MODELS.find((candidate) => candidate.id === model.id)
    return {
      ...model,
      minPlan:
        policy && CodiumPlan.rank(policy.minPlan) > CodiumPlan.rank(model.minPlan) ? policy.minPlan : model.minPlan,
      ...(policy ? { lab: policy.lab } : {}),
      ...(CAPTURED_RESERVATIONS[model.id] ? { providerOnly: [CAPTURED_RESERVATIONS[model.id]!.tag] } : {}),
    }
  })
}

/**
 * Only the unchanged captured five-model routing policy is qualified for production today. New variants, pins,
 * effort values or larger windows need provider evidence before this boundary can authorize them. Local HTTP fakes
 * inject their own explicit qualification; no environment flag can qualify a route.
 */
export function capturedGatewayModel(model: ModelPlanModel) {
  const reviewed: ModelPlanModel | undefined = CODIUM_MODELS.find((candidate) => candidate.id === model.id)
  const bounds = CAPTURED_RESERVATIONS[model.id]
  if (
    !reviewed ||
    !bounds ||
    model.upstream !== undefined ||
    model.providerOnly?.length !== 1 ||
    model.providerOnly[0] !== bounds.tag ||
    model.tierContext !== undefined ||
    !Number.isSafeInteger(model.contextLength) ||
    !Number.isSafeInteger(model.maxOutputTokens) ||
    model.contextLength < model.maxOutputTokens ||
    model.maxOutputTokens < 1 ||
    model.contextLength > reviewed.contextLength ||
    model.maxOutputTokens > reviewed.maxOutputTokens
  )
    return false
  return (
    [
      "inputPrice",
      "outputPrice",
      "quantizations",
      "reasoningEffort",
      "explicitCache",
      "cacheStyle",
      "autoToolChoice",
      "outputTokenParameter",
      "promptTokenLimit",
      "options",
    ] as const
  ).every((field) => JSON.stringify(model[field]) === JSON.stringify(reviewed[field]))
}

export function verifiedGatewayModel(model: ModelPlanModel) {
  if (!capturedGatewayModel(model)) return false
  return ROUTE_ACCEPTANCES.some(
    (accepted) =>
      accepted.model === model.id &&
      accepted.tag === model.providerOnly?.[0] &&
      accepted.captureSha256 === RESERVATION_CAPTURE.sha256 &&
      accepted.source.trim() &&
      Number.isSafeInteger(accepted.acceptedAt) &&
      accepted.acceptedAt > 0 &&
      accepted.acceptedAt <= Date.now() &&
      accepted.nativeWindowEnforced &&
      accepted.outputIncludesReasoning &&
      accepted.exactTagWithZdr &&
      accepted.capturedRatesBoundCharges,
  )
}
