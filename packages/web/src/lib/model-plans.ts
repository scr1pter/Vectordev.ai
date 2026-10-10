export type ModelPlan = { id: string; name: string; price: number; credits: number; available: boolean }
export type ModelPlanModel = {
  id: string
  name: string
  contextLength: number
  maxOutputTokens: number
  inputPrice: number
  outputPrice: number
  category?: "everyday" | "advanced"
  description?: string
}
export type ModelPlanConfig = {
  enabled: boolean
  currency: "usd"
  interval: "month"
  plans: ModelPlan[]
  topups?: ModelPlan[]
  product?: string
  models?: ModelPlanModel[]
}
export type ModelPlanWallet = { credits: number; used?: number; remaining?: number }
export type ModelPlanStatus = (
  | { active: false; customer?: boolean }
  | {
      active: true
      plan: string
      credits: number
      used?: number
      remaining?: number
      periodStart: number
      periodEnd: number
      cancelAtPeriodEnd: boolean
    }
) & { access?: boolean; wallet?: ModelPlanWallet }

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
          !amount(model.contextLength) ||
          !Number.isSafeInteger(model.contextLength) ||
          model.contextLength < 1 ||
          !amount(model.maxOutputTokens) ||
          !Number.isSafeInteger(model.maxOutputTokens) ||
          model.maxOutputTokens < 1 ||
          model.maxOutputTokens > model.contextLength ||
          !amount(model.inputPrice) ||
          model.inputPrice === 0 ||
          !amount(model.outputPrice) ||
          model.outputPrice === 0 ||
          (model.category !== undefined && model.category !== "everyday" && model.category !== "advanced") ||
          (model.description !== undefined && (typeof model.description !== "string" || !model.description.trim()))
        )
          throw new Error("Vector could not load model plans. Try again.")
        return {
          id: model.id,
          name: model.name,
          contextLength: model.contextLength,
          maxOutputTokens: model.maxOutputTokens,
          inputPrice: model.inputPrice,
          outputPrice: model.outputPrice,
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
  if (!record(value) || (value.access !== undefined && typeof value.access !== "boolean"))
    throw new Error("Vector could not load your model plan. Try again.")
  const wallet = value.wallet
  if (
    wallet !== undefined &&
    (!record(wallet) ||
      !amount(wallet.credits) ||
      (wallet.used !== undefined && !amount(wallet.used)) ||
      (wallet.remaining !== undefined && !amount(wallet.remaining)))
  )
    throw new Error("Vector could not load your model plan. Try again.")
  const purchased = {
    ...(typeof value.access === "boolean" ? { access: value.access } : {}),
    ...(record(wallet) && amount(wallet.credits)
      ? {
          wallet: {
            credits: wallet.credits,
            ...(amount(wallet.used) ? { used: wallet.used } : {}),
            ...(amount(wallet.remaining) ? { remaining: wallet.remaining } : {}),
          },
        }
      : {}),
  }
  if (
    record(value) &&
    value.active === false &&
    (value.customer === undefined || typeof value.customer === "boolean")
  ) {
    return { active: false, ...(value.customer === undefined ? {} : { customer: value.customer }), ...purchased }
  }
  if (
    !record(value) ||
    value.active !== true ||
    typeof value.plan !== "string" ||
    !value.plan ||
    !amount(value.credits) ||
    (value.used !== undefined && !amount(value.used)) ||
    (value.remaining !== undefined && !amount(value.remaining)) ||
    !amount(value.periodStart) ||
    !amount(value.periodEnd) ||
    !Number.isFinite(new Date(value.periodEnd).getTime()) ||
    value.periodEnd <= value.periodStart ||
    typeof value.cancelAtPeriodEnd !== "boolean"
  ) {
    throw new Error("Vector could not load your model plan. Try again.")
  }
  return {
    active: true,
    plan: value.plan,
    credits: value.credits,
    ...(value.used === undefined ? {} : { used: value.used }),
    ...(value.remaining === undefined ? {} : { remaining: value.remaining }),
    periodStart: value.periodStart,
    periodEnd: value.periodEnd,
    cancelAtPeriodEnd: value.cancelAtPeriodEnd,
    ...purchased,
  }
}

export function modelPlanRemaining(status: ModelPlanStatus) {
  if (!status.active) return
  if (status.remaining !== undefined) return Math.min(status.credits, status.remaining)
  if (status.used !== undefined) return Math.max(0, status.credits - status.used)
}

export function modelPlanPurchasable(config: ModelPlanConfig, plan: ModelPlan, status: ModelPlanStatus | undefined) {
  return config.enabled && plan.available && plan.credits > 0 && status?.active === false
}

export function modelTopupPurchasable(config: ModelPlanConfig, pack: ModelPlan, status: ModelPlanStatus | undefined) {
  return config.enabled && pack.available && pack.credits > 0 && status !== undefined
}

export function modelWalletRemaining(wallet: ModelPlanWallet) {
  if (wallet.remaining !== undefined) return Math.min(wallet.credits, wallet.remaining)
  if (wallet.used !== undefined) return Math.max(0, wallet.credits - wallet.used)
}

export function modelPlanTokenEstimate(credits: number, models: ModelPlanModel[] = []) {
  if (!amount(credits) || credits === 0) return
  const rates = models
    .map((model) => model.inputPrice * 0.8 + model.outputPrice * 0.2)
    .filter((value) => Number.isFinite(value) && value > 0)
  if (!rates.length) return
  const min = Math.floor((credits / Math.max(...rates)) * 1_000_000)
  const max = Math.floor((credits / Math.min(...rates)) * 1_000_000)
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) return
  return { min, max }
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
    !amount(plan.credits) ||
    typeof plan.available !== "boolean"
  )
    throw new Error("Vector could not load model plans. Try again.")
  return { id: plan.id, name: plan.name, price: plan.price, credits: plan.credits, available: plan.available }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
