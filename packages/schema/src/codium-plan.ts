export * as CodiumPlan from "./codium-plan.js"

/**
 * Vector Codium's monthly plans, cheapest first, by the names people read. The ids are what checkout sold and what
 * Stripe's metadata, links and running subscriptions record, so a rename changes only `name` and never `id`.
 */
export const PLANS = [
  { id: "vector-10", name: "Plus", price: 10 },
  { id: "vector-50", name: "Pro", price: 50 },
  { id: "vector-100", name: "Max", price: 100 },
  { id: "vector-200", name: "Ultra", price: 200 },
] as const

/** One-time credit packs at the plans' prices. A top-up is not a plan, so it is named by what it costs. */
export const TOPUPS = PLANS.map((plan) => ({
  id: `codium-topup-${plan.price}`,
  name: `$${plan.price} credit top-up`,
  price: plan.price,
}))

/** What an account without a Codium subscription is on, as the sidebar and Settings say. */
export const FREE = "Free"

/** The name of the plan or top-up with this id, or undefined for an id Vector does not sell. */
export function name(id: string) {
  return [...PLANS, ...TOPUPS].find((item) => item.id === id)?.name
}
