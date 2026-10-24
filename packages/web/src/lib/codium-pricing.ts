import type { ModelPlan, ModelPlanConfig } from "./model-plans"

export type CodiumPricingView = ReturnType<typeof codiumPricing>
export type CodiumOffer = CodiumPricingView["monthly"][number]

/**
 * The /codium page's view of the public Codium configuration: names, prices, each offer's credits as a multiple of the
 * smallest offer, and usage as ranges of typical agent tasks for each model. The public configuration carries no
 * credit amounts or model prices, so neither the page nor the props serialized for its island can reveal them.
 */
export function codiumPricing(config: ModelPlanConfig) {
  const models = config.models ?? []
  const offers = (plans: ModelPlan[]) =>
    plans.map((plan) => ({
      id: plan.id,
      // The account page's name too, such as "Pro" or "$10 credit top-up", so a top-up never shares a plan's name.
      name: plan.name,
      price: plan.price,
      available: config.enabled && plan.available,
      multiple: plan.multiple,
      // Typical agent tasks for each catalog model, in catalog order.
      tasks: models.map((_, index) => plan.tasks?.[index] ?? null),
    }))
  return {
    enabled: config.enabled,
    models,
    monthly: offers(config.plans),
    topups: offers(config.topups ?? []),
  }
}
