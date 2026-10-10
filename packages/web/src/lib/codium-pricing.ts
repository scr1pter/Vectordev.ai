import { modelPlanTokenEstimate, type ModelPlan, type ModelPlanConfig } from "./model-plans"

export type CodiumOffer = {
  id: string
  name: string
  price: number
  /** Customer-facing Codium credits: 100 for each dollar of model credit. */
  credits: number
  available: boolean
  tokens?: { min: number; max: number }
  /** Estimated tokens for each catalog model, in catalog order. */
  usage: (number | undefined)[]
}

export type CodiumPricing = ReturnType<typeof codiumPricing>

/**
 * The public pricing page's view of the Codium configuration. It keeps only Codium credits and token estimates:
 * dollar credit amounts and model prices stay on the server, so neither the rendered page nor the props serialized
 * for its island reveal supplier cost or the difference between a purchase price and its credits.
 */
export function codiumPricing(config: ModelPlanConfig) {
  const models = config.models ?? []
  const offer = (plan: ModelPlan): CodiumOffer => ({
    id: plan.id,
    name: plan.name,
    price: plan.price,
    credits: Math.round(plan.credits * 100),
    available: config.enabled && plan.available && plan.credits > 0,
    tokens: modelPlanTokenEstimate(plan.credits, models),
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
