import { modelPlanTokenEstimate, type ModelPlan, type ModelPlanConfig } from "./model-plans"

export type CodiumPricingView = ReturnType<typeof codiumPricing>
export type CodiumOffer = CodiumPricingView["monthly"][number]

/**
 * The public pricing page's view of the Codium configuration. It keeps only Codium credits and token estimates:
 * dollar credit amounts and model prices stay on the server, so neither the rendered page nor the props serialized
 * for its island reveal supplier cost or the difference between a purchase price and its credits.
 */
export function codiumPricing(config: ModelPlanConfig) {
  const models = config.models ?? []
  const offer = (plan: ModelPlan) => ({
    id: plan.id,
    name: plan.name,
    price: plan.price,
    // Customer-facing Codium credits: 100 for each dollar of model credit.
    credits: Math.round(plan.credits * 100),
    available: config.enabled && plan.available && plan.credits > 0,
    tokens: modelPlanTokenEstimate(plan.credits, models),
    // Estimated tokens for each catalog model, in catalog order.
    usage: models.map((model) => modelPlanTokenEstimate(plan.credits, [model])?.min),
  })
  return {
    enabled: config.enabled,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.category === undefined ? {} : { category: model.category }),
      ...(model.description === undefined ? {} : { description: model.description }),
    })),
    monthly: config.plans.map(offer),
    topups: (config.topups ?? []).map(offer),
  }
}
