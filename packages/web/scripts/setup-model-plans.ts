import {
  MODEL_PLAN_STRIPE_VERSION,
  MODEL_PLAN_WEBHOOK_EVENTS,
  modelPlanStripe,
  stripeRecord,
} from "../../../api/_lib/model-plan-stripe"
import { MODEL_PLAN_PRICES, modelPlanOrigin, modelPlans, modelTopups } from "../../../api/_lib/model-plan-config"

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
    `And a webhook to ${modelPlanOrigin()}/api/model-plans/webhook (API ${MODEL_PLAN_STRIPE_VERSION}) for: ${MODEL_PLAN_WEBHOOK_EVENTS.join(", ")}.`,
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

const portal = await modelPlanStripe("billing_portal/configurations", {
  method: "POST",
  idempotency: "vector-model-portal-v1",
  body: new URLSearchParams({
    "business_profile[headline]": "Manage your Vector Codium subscription",
    "features[customer_update][enabled]": "true",
    "features[customer_update][allowed_updates][0]": "email",
    "features[invoice_history][enabled]": "true",
    "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": "false",
  }),
})
if (typeof portal.id !== "string") throw new Error("Stripe did not return a billing portal configuration.")
console.log(`STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID=${portal.id}`)

// Stripe shows a webhook's signing secret only when it is created, so an existing endpoint is reported, not replaced.
const webhook = `${modelPlanOrigin()}/api/model-plans/webhook`
const endpoints = await modelPlanStripe("webhook_endpoints?limit=100")
const registered = (Array.isArray(endpoints.data) ? endpoints.data.filter(stripeRecord) : []).find(
  (endpoint) => endpoint.url === webhook,
)
if (registered) {
  const events = Array.isArray(registered.enabled_events) ? registered.enabled_events : []
  const missing = MODEL_PLAN_WEBHOOK_EVENTS.filter((name) => !events.includes(name) && !events.includes("*"))
  console.log(
    `Webhook ${String(registered.id)} already sends to ${webhook}; its signing secret is in the Stripe dashboard.` +
      (missing.length ? ` Add these events to it: ${missing.join(", ")}.` : ""),
  )
} else {
  const body = new URLSearchParams({
    url: webhook,
    api_version: MODEL_PLAN_STRIPE_VERSION,
    description: "Vector Codium credits and ledger",
  })
  MODEL_PLAN_WEBHOOK_EVENTS.forEach((name, index) => body.set(`enabled_events[${index}]`, name))
  const created = await modelPlanStripe("webhook_endpoints", {
    method: "POST",
    idempotency: "vector-codium-webhook-v1",
    body,
  })
  if (typeof created.secret !== "string") throw new Error("Stripe did not return the webhook's signing secret.")
  console.log(`STRIPE_MODEL_PLAN_WEBHOOK_SECRET=${created.secret}`)
}
console.log(
  "Prices are prepared. Keep MODEL_PLANS_ENABLED=false until allowances, model catalog, webhook, funding and live verification are complete.",
)
