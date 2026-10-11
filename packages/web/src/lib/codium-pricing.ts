import type { ModelPlan, ModelPlanConfig, ModelPlanModel } from "./model-plans"

export type CodiumPricingView = ReturnType<typeof codiumPricing>
export type CodiumOffer = CodiumPricingView["monthly"][number]

// What a typical agent task costs each model, behind the public usage ranges. Prices are USD per million tokens at
// the price OpenRouter's price-weighted routing is expected to pay across the model's ZDR endpoints; token counts run
// from a focused fix to a multi-file change. docs/vector/MODEL-PLANS.md derives every number. They stay on the server:
// the page and its island props receive only the rounded ranges.
const CACHED = 0.9
const TASK_USAGE: Record<string, { price: { input: number; cached: number; output: number }; tasks: TaskTokens[] }> = {
  "deepseek/deepseek-v4.1-flash": {
    price: { input: 0.11, cached: 0.008, output: 0.54 },
    tasks: [
      { input: 500_000, output: 10_000 },
      { input: 5_000_000, output: 75_000 },
    ],
  },
  "xiaomi/mimo-v2.6-flash": {
    price: { input: 0.15, cached: 0.005, output: 0.3 },
    tasks: [
      { input: 400_000, output: 8_000 },
      { input: 3_500_000, output: 60_000 },
    ],
  },
  "anthropic/claude-haiku-5.5": {
    // Uncached input is priced as a prompt-cache write.
    price: { input: 0.13, cached: 0.011, output: 0.55 },
    tasks: [
      { input: 600_000, output: 25_000 },
      { input: 6_000_000, output: 180_000 },
    ],
  },
}
// A model without reviewed assumptions is priced at its routing ceilings with no cache discount.
const DEFAULT_TASKS = TASK_USAGE["deepseek/deepseek-v4.1-flash"]!.tasks
type TaskTokens = { input: number; output: number }

/**
 * The public pricing page's view of the Codium configuration: names, prices, each offer's credits as a multiple of
 * the smallest offer, and usage as ranges of typical agent tasks. Credit amounts, model prices and the assumptions
 * behind the ranges stay on the server, so neither the rendered page nor the props serialized for its island reveal
 * supplier cost or the difference between a purchase price and its credits.
 */
export function codiumPricing(config: ModelPlanConfig) {
  const models = config.models ?? []
  const offers = (plans: ModelPlan[]) =>
    plans.map((plan) => ({
      id: plan.id,
      // A top-up is named for the plan of the same price; the tab and its price line say it is one-time.
      name: plan.name.replace(/ top-up$/i, ""),
      price: plan.price,
      available: config.enabled && plan.available && plan.credits > 0,
      multiple:
        plans[0]!.credits > 0 && plan.credits > plans[0]!.credits
          ? Math.round((plan.credits / plans[0]!.credits) * 10) / 10
          : undefined,
      // Typical agent tasks for each catalog model, in catalog order.
      tasks: models.map((model) => taskRange(plan.credits, model)),
    }))
  return {
    enabled: config.enabled,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.category === undefined ? {} : { category: model.category }),
      ...(model.description === undefined ? {} : { description: model.description }),
    })),
    monthly: offers(config.plans),
    topups: offers(config.topups ?? []),
  }
}

/** How many typical tasks a purchase covers, from the larger task to the smaller, rounded down to two digits. */
function taskRange(credits: number, model: ModelPlanModel) {
  const usage = TASK_USAGE[model.id] ?? {
    price: { input: model.inputPrice, cached: model.inputPrice, output: model.outputPrice },
    tasks: DEFAULT_TASKS,
  }
  const [low, high] = usage.tasks
    .map(
      (task) =>
        (task.input * (1 - CACHED) * usage.price.input +
          task.input * CACHED * usage.price.cached +
          task.output * usage.price.output) /
        1_000_000,
    )
    .map((cost) => credits / cost)
    .toSorted((a, b) => a - b)
    .map((tasks) => {
      const step = 10 ** Math.max(0, Math.floor(Math.log10(tasks)) - 1)
      return Math.floor(tasks / step) * step
    })
  if (!(low! >= 1)) return
  return [low!, high!] as const
}
