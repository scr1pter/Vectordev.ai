import { randomUUID } from "node:crypto"
import {
  MODEL_PLAN_STRIPE_VERSION,
  MODEL_PLAN_WEBHOOK_EVENTS,
  modelPlanStripe,
  stripeRecord,
} from "../../../api/_lib/model-plan-stripe"

// Mark the portal configurations this script creates, so a later run finds and reuses them.
const PORTAL_MARK = "portal-v1"
const CHANGE_PORTAL_MARK = "plan-change-v1"

/**
 * Codium's customer portal: the one an earlier run created, or a new one. Stripe keeps an idempotency key for only a
 * day, so a fixed key would make a later run create a second configuration; the metadata mark finds the first.
 */
export async function modelPlanPortalConfiguration(fetcher: typeof fetch = fetch) {
  const existing = (await stripeList("billing_portal/configurations?active=true", fetcher)).find(
    (configuration) => stripeRecord(configuration.metadata) && configuration.metadata.vector_codium === PORTAL_MARK,
  )
  if (existing) {
    const features = stripeRecord(existing.features) ? existing.features : undefined
    const switching = features && stripeRecord(features.subscription_update) ? features.subscription_update : undefined
    // This portal opens while Codium sales are paused, when a plan change would sell credits Vector may not be able
    // to pay for; changes have their own configuration below.
    if (switching?.enabled !== false)
      throw new Error(`Turn plan switching off in Stripe's portal configuration ${String(existing.id)}.`)
    return { id: String(existing.id), created: false }
  }
  const portal = await modelPlanStripe(
    "billing_portal/configurations",
    {
      method: "POST",
      idempotency: `vector-codium-portal-${randomUUID()}`,
      body: new URLSearchParams({
        "business_profile[headline]": "Manage your Vector Codium subscription",
        "features[customer_update][enabled]": "true",
        "features[customer_update][allowed_updates][0]": "email",
        "features[invoice_history][enabled]": "true",
        "features[payment_method_update][enabled]": "true",
        "features[subscription_cancel][enabled]": "true",
        "features[subscription_cancel][mode]": "at_period_end",
        "features[subscription_update][enabled]": "false",
        "metadata[vector_codium]": PORTAL_MARK,
      }),
    },
    fetcher,
  )
  if (typeof portal.id !== "string") throw new Error("Stripe did not return a billing portal configuration.")
  return { id: portal.id, created: true }
}

/**
 * The portal that also changes plans between the four monthly products, opened only while Codium is on sale. Its
 * settings keep Stripe's billing in step with what Codium grants for a paid period: a full invoice for a whole month.
 * - A bigger plan applies at once and starts a new month on it, charged in full today (no proration, billing cycle
 *   anchor reset). A prorated charge pays for part of a month, which Codium never grants, so it would leave the
 *   subscriber without monthly credits until renewal.
 * - A smaller plan waits for the renewal date, when its own full invoice starts its month.
 * An earlier run's configuration is updated to these settings and the current prices, so it stays the same ID.
 */
export async function modelPlanChangePortalConfiguration(
  plans: readonly { product: string; price: string }[],
  fetcher: typeof fetch = fetch,
) {
  const body = new URLSearchParams({
    "business_profile[headline]": "Manage your Vector Codium subscription",
    "features[customer_update][enabled]": "true",
    "features[customer_update][allowed_updates][0]": "email",
    "features[invoice_history][enabled]": "true",
    "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": "true",
    "features[subscription_update][default_allowed_updates][0]": "price",
    "features[subscription_update][proration_behavior]": "none",
    "features[subscription_update][billing_cycle_anchor]": "now",
    "features[subscription_update][schedule_at_period_end][conditions][0][type]": "decreasing_item_amount",
  })
  plans.forEach((plan, index) => {
    body.set(`features[subscription_update][products][${index}][product]`, plan.product)
    body.set(`features[subscription_update][products][${index}][prices][0]`, plan.price)
  })
  const existing = (await stripeList("billing_portal/configurations?active=true", fetcher)).find(
    (configuration) =>
      stripeRecord(configuration.metadata) && configuration.metadata.vector_codium === CHANGE_PORTAL_MARK,
  )
  if (existing) {
    await modelPlanStripe(
      `billing_portal/configurations/${encodeURIComponent(String(existing.id))}`,
      { method: "POST", idempotency: `vector-codium-change-portal-update-${randomUUID()}`, body },
      fetcher,
    )
    return { id: String(existing.id), created: false }
  }
  body.set("metadata[vector_codium]", CHANGE_PORTAL_MARK)
  const portal = await modelPlanStripe(
    "billing_portal/configurations",
    { method: "POST", idempotency: `vector-codium-change-portal-${randomUUID()}`, body },
    fetcher,
  )
  if (typeof portal.id !== "string") throw new Error("Stripe did not return a billing portal configuration.")
  return { id: portal.id, created: true }
}

/**
 * The Codium webhook at `url`. Stripe shows a webhook's signing secret only when it is created, so an existing
 * endpoint at the same address is kept (its URL updated when only the query differs, as when the preview's protection
 * bypass secret changes) and its missing events are reported. A new endpoint is confirmed in a fresh listing before
 * its secret is printed: a replayed create could otherwise return the secret of an endpoint that was since deleted.
 */
export async function modelPlanWebhook(url: string, fetcher: typeof fetch = fetch) {
  const target = new URL(url)
  const registered = (await stripeList("webhook_endpoints", fetcher)).find((endpoint) => {
    const address = typeof endpoint.url === "string" && URL.canParse(endpoint.url) ? new URL(endpoint.url) : undefined
    return address?.origin === target.origin && address.pathname === target.pathname
  })
  if (registered) {
    if (registered.url !== url)
      await modelPlanStripe(
        `webhook_endpoints/${encodeURIComponent(String(registered.id))}`,
        {
          method: "POST",
          idempotency: `vector-codium-webhook-update-${randomUUID()}`,
          body: new URLSearchParams({ url }),
        },
        fetcher,
      )
    const events = Array.isArray(registered.enabled_events) ? registered.enabled_events : []
    return {
      id: String(registered.id),
      created: false as const,
      missing: MODEL_PLAN_WEBHOOK_EVENTS.filter((name) => !events.includes(name) && !events.includes("*")),
    }
  }
  const body = new URLSearchParams({
    url,
    api_version: MODEL_PLAN_STRIPE_VERSION,
    description: "Vector Codium credits and ledger",
  })
  MODEL_PLAN_WEBHOOK_EVENTS.forEach((name, index) => body.set(`enabled_events[${index}]`, name))
  const created = await modelPlanStripe(
    "webhook_endpoints",
    { method: "POST", idempotency: `vector-codium-webhook-${randomUUID()}`, body },
    fetcher,
  )
  if (typeof created.id !== "string" || typeof created.secret !== "string")
    throw new Error("Stripe did not return the webhook's signing secret.")
  if (!(await stripeList("webhook_endpoints", fetcher)).some((value) => value.id === created.id && value.url === url))
    throw new Error(`Stripe does not list the new webhook ${created.id}; run the script again.`)
  return { id: created.id, created: true as const, secret: created.secret }
}

/** Every object in a Stripe list, page by page. */
async function stripeList(
  path: string,
  fetcher: typeof fetch,
  after?: string,
  pages = 0,
): Promise<Record<string, unknown>[]> {
  if (pages >= 50) throw new Error(`Stripe's ${path} listing did not end.`)
  const query = new URLSearchParams({ limit: "100", ...(after ? { starting_after: after } : {}) })
  const result = await modelPlanStripe(`${path}${path.includes("?") ? "&" : "?"}${query}`, {}, fetcher)
  if (!Array.isArray(result.data)) throw new Error(`Stripe's ${path} listing could not be read.`)
  const data = result.data.filter(stripeRecord)
  const last = data.at(-1)?.id
  if (result.has_more !== true) return data
  if (typeof last !== "string" || last === after) throw new Error(`Stripe's ${path} listing did not move on.`)
  return [...data, ...(await stripeList(path, fetcher, last, pages + 1))]
}
