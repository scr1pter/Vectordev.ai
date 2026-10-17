import {
  MODEL_PLAN_STRIPE_VERSION,
  MODEL_PLAN_WEBHOOK_EVENTS,
  modelPlanStripe,
  stripeRecord,
} from "../../../api/_lib/model-plan-stripe"
import { MODEL_PLAN_PRICES, modelPlanOrigin, modelPlans, modelTopups } from "../../../api/_lib/model-plan-config"
import { modelPlanPortalConfiguration, modelPlanWebhook } from "./model-plan-setup"

// A protected preview deployment lets Stripe's notifications through only with Vercel's automation bypass secret.
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()
const webhook = `${modelPlanOrigin()}/api/model-plans/webhook${bypass ? `?${new URLSearchParams({ "x-vercel-protection-bypass": bypass })}` : ""}`

// Dry-run by default. Execute with --apply only in the intended Stripe account.
if (!Bun.argv.includes("--apply")) {
  console.log(
    `Vector Codium: monthly subscriptions and one-time top-ups at ${MODEL_PLAN_PRICES.map((price) => `$${price}`).join(", ")}.`,
  )
  console.table(
    modelPlans().map((plan) => ({
      price: plan.price,
      monthlyCredits: plan.credits,
      topupCredits: modelTopups().find((pack) => pack.price === plan.price)?.credits,
    })),
  )
  console.log("Also creates a billing portal with payment-method updates, invoices and cancellation at period end.")
  console.log(
    `And a webhook to ${modelPlanOrigin()}/api/model-plans/webhook${bypass ? " (with the preview's protection bypass)" : ""} (API ${MODEL_PLAN_STRIPE_VERSION}) for: ${MODEL_PLAN_WEBHOOK_EVENTS.join(", ")}.`,
  )
  console.log(
    "No changes made. Set STRIPE_SECRET_KEY to a test key and run again with --apply to prepare test billing.",
  )
  process.exit(0)
}

for (const amount of MODEL_PLAN_PRICES) {
  const lookup = `vector-models-${amount}-monthly-v1`
  const result = await modelPlanStripe(`prices?${new URLSearchParams({ "lookup_keys[]": lookup, limit: "2" })}`)
  const existing = Array.isArray(result.data) ? result.data.filter(stripeRecord) : []
  if (existing.length > 1) throw new Error(`More than one Stripe price matches ${lookup}.`)
  const price =
    existing[0] ??
    (await modelPlanStripe("prices", {
      method: "POST",
      idempotency: lookup,
      body: new URLSearchParams({
        currency: "usd",
        unit_amount: String(amount * 100),
        "recurring[interval]": "month",
        "product_data[name]": `Vector Codium ${amount}`,
        lookup_key: lookup,
      }),
    }))
  if (
    price.currency !== "usd" ||
    price.unit_amount !== amount * 100 ||
    price.active !== true ||
    !stripeRecord(price.recurring) ||
    price.recurring.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    typeof price.id !== "string"
  )
    throw new Error(`Existing Stripe price ${lookup} has unexpected billing settings.`)
  console.log(`STRIPE_MODEL_PLAN_${amount}_PRICE_ID=${price.id}`)
}

for (const pack of modelTopups()) {
  const lookup = `vector-codium-topup-${pack.price}-v1`
  const result = await modelPlanStripe(`prices?${new URLSearchParams({ "lookup_keys[]": lookup, limit: "2" })}`)
  const existing = Array.isArray(result.data) ? result.data.filter(stripeRecord) : []
  if (existing.length > 1) throw new Error(`More than one Stripe price matches ${lookup}.`)
  const price =
    existing[0] ??
    (await modelPlanStripe("prices", {
      method: "POST",
      idempotency: lookup,
      body: new URLSearchParams({
        currency: "usd",
        unit_amount: String(pack.price * 100),
        "product_data[name]": `Vector Codium ${pack.price} top-up`,
        lookup_key: lookup,
      }),
    }))
  if (
    price.currency !== "usd" ||
    price.unit_amount !== pack.price * 100 ||
    price.active !== true ||
    price.recurring ||
    typeof price.id !== "string"
  )
    throw new Error(`Existing Stripe price ${lookup} has unexpected billing settings.`)
  console.log(`STRIPE_MODEL_TOPUP_${pack.price}_PRICE_ID=${price.id}`)
}

const portal = await modelPlanPortalConfiguration()
console.log(`STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID=${portal.id}`)

const endpoint = await modelPlanWebhook(webhook)
if (endpoint.created) console.log(`STRIPE_MODEL_PLAN_WEBHOOK_SECRET=${endpoint.secret}`)
if (!endpoint.created)
  console.log(
    `Webhook ${endpoint.id} already sends to ${modelPlanOrigin()}/api/model-plans/webhook; its signing secret is in the Stripe dashboard.` +
      (endpoint.missing.length ? ` Add these events to it: ${endpoint.missing.join(", ")}.` : ""),
  )
console.log(
  "Prices are prepared. Keep MODEL_PLANS_ENABLED=false until allowances, model catalog, webhook, funding and live verification are complete.",
)
