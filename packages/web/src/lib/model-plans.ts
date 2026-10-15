/**
 * A purchase as the public configuration describes it. It never carries credit amounts: `multiple` is its credits as a
 * multiple of the smallest purchase, and `tasks` its typical tasks for each catalog model, in catalog order.
 */
export type ModelPlan = {
  id: string
  name: string
  price: number
  available: boolean
  multiple?: number
  tasks?: (readonly [number, number] | null)[]
}
export type ModelPlanModel = { id: string; name: string; category?: "everyday" | "advanced"; description?: string }
export type ModelPlanConfig = {
  enabled: boolean
  currency: "usd"
  interval: "month"
  plans: ModelPlan[]
  topups?: ModelPlan[]
  product?: string
  models?: ModelPlanModel[]
}
/**
 * The signed-in account's own balances, as /api/model-plans/status answers: shares of what was bought, from 0 to 1, and
 * flags the server works out. Credit amounts never leave the server.
 */
export type ModelPlanStatus = {
  active: boolean
  customer?: boolean
  access?: boolean
  plan?: { id: string; name: string; left?: number; renewsAt: number; cancelAtPeriodEnd: boolean }
  purchased?: { bought: boolean; left?: number }
  empty?: boolean
  low?: boolean
}

export function readModelPlanConfig(value: unknown): ModelPlanConfig {
  if (
    !record(value) ||
    typeof value.enabled !== "boolean" ||
    value.currency !== "usd" ||
    value.interval !== "month" ||
    !Array.isArray(value.plans) ||
    (value.topups !== undefined && !Array.isArray(value.topups)) ||
    (value.product !== undefined && (typeof value.product !== "string" || !value.product.trim())) ||
    (value.models !== undefined && !Array.isArray(value.models))
  ) {
    throw new Error("Vector could not load model plans. Try again.")
  }
  const plans = value.plans.map(readPlan)
  const topups = Array.isArray(value.topups) ? value.topups.map(readPlan) : undefined
  const ids = [...plans, ...(topups ?? [])].map((plan) => plan.id)
  if (new Set(ids).size !== ids.length) throw new Error("Vector could not load model plans. Try again.")
  const models = Array.isArray(value.models)
    ? value.models.map((model: unknown): ModelPlanModel => {
        if (
          !record(model) ||
          typeof model.id !== "string" ||
          !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model.id) ||
          typeof model.name !== "string" ||
          !model.name.trim() ||
          (model.category !== undefined && model.category !== "everyday" && model.category !== "advanced") ||
          (model.description !== undefined && (typeof model.description !== "string" || !model.description.trim()))
        )
          throw new Error("Vector could not load model plans. Try again.")
        return {
          id: model.id,
          name: model.name,
          ...(model.category === undefined ? {} : { category: model.category }),
          ...(model.description === undefined ? {} : { description: model.description }),
        }
      })
    : undefined
  if (models && (models.length > 30 || new Set(models.map((model) => model.id)).size !== models.length))
    throw new Error("Vector could not load model plans. Try again.")
  return {
    enabled: value.enabled,
    currency: value.currency,
    interval: value.interval,
    plans,
    ...(topups === undefined ? {} : { topups }),
    ...(typeof value.product === "string" ? { product: value.product } : {}),
    ...(models === undefined ? {} : { models }),
  }
}

export function readModelPlanStatus(value: unknown): ModelPlanStatus {
  if (
    !record(value) ||
    typeof value.active !== "boolean" ||
    ["customer", "access", "empty", "low"].some((key) => value[key] !== undefined && typeof value[key] !== "boolean")
  )
    throw statusError()
  const plan = value.plan === undefined ? undefined : readStatusPlan(value.plan)
  const purchased = value.purchased === undefined ? undefined : readPurchased(value.purchased)
  // A plan is reported exactly when a paid subscription period is active.
  if (value.active !== (plan !== undefined)) throw statusError()
  return {
    active: value.active,
    ...(typeof value.customer === "boolean" ? { customer: value.customer } : {}),
    ...(typeof value.access === "boolean" ? { access: value.access } : {}),
    ...(plan ? { plan } : {}),
    ...(purchased ? { purchased } : {}),
    ...(typeof value.empty === "boolean" ? { empty: value.empty } : {}),
    ...(typeof value.low === "boolean" ? { low: value.low } : {}),
  }
}

export function modelPlanPurchasable(config: ModelPlanConfig, plan: ModelPlan, status: ModelPlanStatus | undefined) {
  return config.enabled && plan.available && status?.active === false
}

export function modelTopupPurchasable(config: ModelPlanConfig, pack: ModelPlan, status: ModelPlanStatus | undefined) {
  return config.enabled && pack.available && status !== undefined
}

/** Only navigate to the Stripe product requested; never trust an arbitrary API redirect. */
export function modelPlanRedirect(value: unknown, action: "checkout" | "portal" | "topup") {
  if (!record(value) || typeof value.url !== "string" || !URL.canParse(value.url))
    throw new Error("Vector could not open billing. Try again.")
  const url = new URL(value.url)
  const origin = action === "portal" ? "https://billing.stripe.com" : "https://checkout.stripe.com"
  if (url.origin !== origin || url.username || url.password)
    throw new Error("Vector could not open billing. Try again.")
  return url.href
}

function readPlan(plan: unknown): ModelPlan {
  if (
    !record(plan) ||
    typeof plan.id !== "string" ||
    !plan.id ||
    typeof plan.name !== "string" ||
    !plan.name.trim() ||
    !amount(plan.price) ||
    plan.price === 0 ||
    typeof plan.available !== "boolean" ||
    (plan.multiple !== undefined && (!amount(plan.multiple) || plan.multiple <= 1)) ||
    (plan.tasks !== undefined &&
      (!Array.isArray(plan.tasks) ||
        plan.tasks.some(
          (range) =>
            range !== null &&
            (!Array.isArray(range) ||
              range.length !== 2 ||
              !amount(range[0]) ||
              !amount(range[1]) ||
              range[0] < 1 ||
              range[1] < range[0]),
        )))
  )
    throw new Error("Vector could not load model plans. Try again.")
  return {
    id: plan.id,
    name: plan.name,
    price: plan.price,
    available: plan.available,
    ...(plan.multiple === undefined ? {} : { multiple: plan.multiple }),
    ...(Array.isArray(plan.tasks)
      ? { tasks: plan.tasks.map((range) => (Array.isArray(range) ? ([range[0], range[1]] as const) : null)) }
      : {}),
  }
}

function readStatusPlan(plan: unknown) {
  if (
    !record(plan) ||
    typeof plan.id !== "string" ||
    !plan.id ||
    typeof plan.name !== "string" ||
    !plan.name.trim() ||
    (plan.left !== undefined && !fraction(plan.left)) ||
    !amount(plan.renewsAt) ||
    !Number.isFinite(new Date(plan.renewsAt).getTime()) ||
    typeof plan.cancelAtPeriodEnd !== "boolean"
  )
    throw statusError()
  return {
    id: plan.id,
    name: plan.name,
    ...(fraction(plan.left) ? { left: plan.left } : {}),
    renewsAt: plan.renewsAt,
    cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
  }
}

function readPurchased(purchased: unknown) {
  if (
    !record(purchased) ||
    typeof purchased.bought !== "boolean" ||
    (purchased.left !== undefined && !fraction(purchased.left))
  )
    throw statusError()
  return { bought: purchased.bought, ...(fraction(purchased.left) ? { left: purchased.left } : {}) }
}

function statusError() {
  return new Error("Vector could not load your model plan. Try again.")
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function fraction(value: unknown): value is number {
  return amount(value) && value <= 1
}
