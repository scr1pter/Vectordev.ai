import { Option, Schema } from "effect"
import { ApiError } from "./http.js"
import { CODIUM_CATALOG_UPDATED, CODIUM_MODELS } from "./codium-catalog.js"

export const MODEL_PLAN_PRICES = [10, 20, 50, 100, 200] as const
export const MODEL_PLAN_ROOT = "https://openrouter.ai/api/v1"
export const ModelPlanModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  contextLength: Schema.Number,
  maxOutputTokens: Schema.Number,
  inputPrice: Schema.Number,
  outputPrice: Schema.Number,
  category: Schema.optional(Schema.Literals(["everyday", "advanced"])),
  description: Schema.optional(Schema.String),
})
export type ModelPlanModel = typeof ModelPlanModel.Type

export function modelPlans() {
  return MODEL_PLAN_PRICES.map((price) => {
    const credits = creditAllowance(price, process.env[`MODEL_PLAN_${price}_CREDITS_USD`])
    const priceID = process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`]?.trim()
    return {
      id: `vector-${price}`,
      name: `Codium ${price}`,
      price,
      credits: Number.isFinite(credits) && credits > 0 && credits <= price ? credits : 0,
      priceID: priceID && /^price_[a-zA-Z0-9]+$/.test(priceID) ? priceID : undefined,
    }
  })
}

export function modelTopups() {
  return MODEL_PLAN_PRICES.map((price) => {
    const priceID = process.env[`STRIPE_MODEL_TOPUP_${price}_PRICE_ID`]?.trim()
    return {
      id: `codium-topup-${price}`,
      name: `Codium ${price} top-up`,
      price,
      credits: creditAllowance(price, process.env[`MODEL_TOPUP_${price}_CREDITS_USD`]),
      priceID: priceID && /^price_[a-zA-Z0-9]+$/.test(priceID) ? priceID : undefined,
    }
  })
}

export function modelCreditMarkup() {
  const value = Number(process.env.MODEL_CREDIT_MARKUP_PERCENT?.trim() || "25")
  if (!Number.isFinite(value) || value < 0 || value > 300) throw configurationError()
  return value
}

function creditAllowance(price: number, override: string | undefined) {
  const credits = override?.trim() ? Number(override) : Math.floor((price * 10_000) / (100 + modelCreditMarkup())) / 100
  return Number.isFinite(credits) && credits > 0 && credits <= price && Math.round(credits * 100) / 100 === credits
    ? credits
    : 0
}

export function modelPlansEnabled() {
  return process.env.MODEL_PLANS_ENABLED === "true"
}

export function configuredPlanModels() {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ModelPlanModel)))(
    process.env.MODEL_PLAN_MODELS_JSON?.trim() || JSON.stringify(CODIUM_MODELS),
  )
  if (Option.isNone(decoded)) throw configurationError()
  const models = decoded.value
  if (
    models.length > 30 ||
    new Set(models.map((model) => model.id)).size !== models.length ||
    models.some(
      (model) =>
        !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:-]+$/.test(model.id) ||
        model.id.endsWith(":free") ||
        !model.name.trim() ||
        !Number.isSafeInteger(model.contextLength) ||
        model.contextLength < 1 ||
        !Number.isSafeInteger(model.maxOutputTokens) ||
        model.maxOutputTokens < 1 ||
        model.maxOutputTokens > model.contextLength ||
        !Number.isFinite(model.inputPrice) ||
        model.inputPrice <= 0 ||
        !Number.isFinite(model.outputPrice) ||
        model.outputPrice <= 0,
    )
  )
    throw configurationError()
  return models
}

export function requireModelPlans() {
  if (!modelPlansEnabled()) throw new ApiError(503, "MODEL_PLANS_DISABLED", "Vector Codium is not available yet.")
  if (!modelPlanConfigurationReady()) throw configurationError()
}

function modelPlanConfigurationReady() {
  return !(
    !process.env.STRIPE_SECRET_KEY?.trim() ||
    !process.env.STRIPE_MODEL_PLAN_WEBHOOK_SECRET?.trim() ||
    !process.env.STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID?.trim() ||
    !process.env.OPENROUTER_MANAGEMENT_KEY?.trim() ||
    !/^[a-fA-F0-9]{64}$/.test(process.env.MODEL_PLAN_KEY_ENCRYPTION_SECRET ?? "") ||
    !configuredPlanModels().length ||
    modelPlans().some((plan) => !plan.credits || !plan.priceID) ||
    new Set(modelPlans().map((plan) => plan.priceID)).size !== MODEL_PLAN_PRICES.length
  )
}

export function requireModelTopups() {
  requireModelPlans()
  const packs = modelTopups()
  if (
    packs.some((pack) => !pack.credits || !pack.priceID) ||
    new Set(packs.map((pack) => pack.priceID)).size !== packs.length
  )
    throw configurationError()
}

export function publicModelPlans() {
  const plans = modelPlans()
  const enabled = modelPlansEnabled() && modelPlanConfigurationReady()
  const topups = modelTopups()
  const topupsEnabled =
    enabled &&
    topups.every((pack) => !!pack.credits && !!pack.priceID) &&
    new Set(topups.map((pack) => pack.priceID)).size === topups.length
  return {
    product: "Vector Codium",
    enabled,
    currency: "usd",
    interval: "month",
    catalogUpdated: CODIUM_CATALOG_UPDATED,
    models: configuredPlanModels(),
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price: plan.price,
      credits: plan.credits,
      available: enabled,
    })),
    topups: topups.map((pack) => ({
      id: pack.id,
      name: pack.name,
      price: pack.price,
      credits: pack.credits,
      available: topupsEnabled,
    })),
  }
}

export function modelPlanOrigin() {
  const url = new URL(process.env.VECTOR_PUBLIC_URL ?? "https://vectordev.ai")
  if (url.protocol !== "https:" || url.username || url.password) throw configurationError()
  return url.origin
}

function configurationError() {
  return new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
}
