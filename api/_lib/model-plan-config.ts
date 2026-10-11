import { Option, Schema } from "effect"
import { ApiError } from "./http.js"
import { CODIUM_CATALOG_UPDATED, CODIUM_MODELS } from "./codium-catalog.js"

export const MODEL_PLAN_PRICES = [10, 50, 100, 200] as const
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

/**
 * What anyone may read about Codium, for /codium and the account page: names, purchase prices, each purchase's credits
 * as a multiple of the smallest one, and usage as ranges of typical tasks per model. Credit amounts, model prices and
 * the task assumptions behind the ranges stay on the server, so no reader can work back to the dollars of model
 * credit in a purchase.
 */
export function publicModelPlans() {
  const enabled = modelPlansEnabled() && modelPlanConfigurationReady()
  const topups = modelTopups()
  const topupsEnabled =
    enabled &&
    topups.every((pack) => !!pack.credits && !!pack.priceID) &&
    new Set(topups.map((pack) => pack.priceID)).size === topups.length
  const models = configuredPlanModels()
  const usage = codiumTaskUsage()
  const offers = (items: { id: string; name: string; price: number; credits: number }[], available: boolean) =>
    items.map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      available: available && item.credits > 0,
      ...(items[0]!.credits > 0 && item.credits > items[0]!.credits
        ? { multiple: Math.round((item.credits / items[0]!.credits) * 10) / 10 }
        : {}),
      // Typical tasks for each model, in catalog order; null where a model has no reviewed assumptions.
      tasks: models.map((model) => taskRange(item.credits, usage[model.id])),
    }))
  return {
    product: "Vector Codium",
    enabled,
    currency: "usd",
    interval: "month",
    catalogUpdated: CODIUM_CATALOG_UPDATED,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.category === undefined ? {} : { category: model.category }),
      ...(model.description === undefined ? {} : { description: model.description }),
    })),
    plans: offers(modelPlans(), enabled),
    topups: offers(topups, topupsEnabled),
  }
}

// The assumptions behind the public usage ranges, per model: the share of input tokens read from the prompt cache,
// the expected input, cached-input and output prices per million tokens, and a smaller and a larger typical task.
// They live only in CODIUM_TASK_USAGE_JSON in the hosting environment: published next to the ranges, they would give
// away each purchase's credits and so the markup.
const TaskTokens = Schema.Struct({ input: Schema.Number, output: Schema.Number })
const ModelTaskUsage = Schema.Struct({
  cached: Schema.Number,
  price: Schema.Struct({ input: Schema.Number, cached: Schema.Number, output: Schema.Number }),
  tasks: Schema.Tuple([TaskTokens, TaskTokens]),
})

function codiumTaskUsage(): Record<string, typeof ModelTaskUsage.Type | undefined> {
  const value = process.env.CODIUM_TASK_USAGE_JSON?.trim()
  if (!value) return {}
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, ModelTaskUsage)))(value)
  if (
    Option.isNone(decoded) ||
    Object.values(decoded.value).some(
      (usage) =>
        !(usage.cached >= 0 && usage.cached <= 1) ||
        !(usage.price.input > 0 && usage.price.output > 0 && usage.price.cached >= 0) ||
        [usage.price.input, usage.price.cached, usage.price.output].some((price) => !Number.isFinite(price)) ||
        usage.tasks.some(
          (task) => !(task.input > 0 && task.output > 0) || !Number.isSafeInteger(task.input + task.output),
        ),
    )
  )
    throw configurationError()
  return decoded.value
}

/** How many typical tasks a purchase covers, from the larger task to the smaller, rounded down to two digits. */
function taskRange(credits: number, usage: typeof ModelTaskUsage.Type | undefined) {
  if (!usage || !(credits > 0)) return null
  const [low, high] = usage.tasks
    .map(
      (task) =>
        credits /
        ((task.input * (1 - usage.cached) * usage.price.input +
          task.input * usage.cached * usage.price.cached +
          task.output * usage.price.output) /
          1_000_000),
    )
    .toSorted((a, b) => a - b)
    .map((tasks) => {
      const step = 10 ** Math.max(0, Math.floor(Math.log10(tasks)) - 1)
      return Math.floor(tasks / step) * step
    })
  if (!(low! >= 1)) return null
  return [low!, high!] as const
}

export function modelPlanOrigin() {
  const url = new URL(process.env.VECTOR_PUBLIC_URL ?? "https://vectordev.ai")
  if (url.protocol !== "https:" || url.username || url.password) throw configurationError()
  return url.origin
}

function configurationError() {
  return new ApiError(503, "MODEL_PLANS_CONFIGURATION", "Vector Codium is temporarily unavailable.")
}
