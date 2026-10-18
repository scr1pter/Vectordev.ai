/**
 * Where Vector's Codium billing window may go. It shows only Stripe's own pages: Checkout, the customer portal and the
 * pages they use for card checks, invoices and receipts. Any other https page opens in the browser, and the window
 * closes itself when Stripe sends the person back to vectordev.ai.
 */
export type BillingOutcome = "completed" | "cancelled" | "closed" | "failed"

/** A main-frame navigation: stay on Stripe, open another https page in the browser, or refuse it. */
export function billingNavigation(url: string) {
  const parsed = URL.parse(url)
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) return "block" as const
  return stripeHost(parsed.hostname) ? ("allow" as const) : ("external" as const)
}

/**
 * What a request to the site means. The return URLs are the ones api/_lib/model-plan-account.ts gives Stripe: checkout
 * and top-ups return to /account?model_plan= or ?model_topup= success or cancelled, a finished plan change or
 * cancellation in the portal returns with model_plan=updated or ending, and the portal's own link back is the bare
 * /account. Any other page of the site opens in the browser; undefined means the URL is not the site's.
 */
export function billingReturn(url: string, origin: string): Exclude<BillingOutcome, "failed"> | "external" | undefined {
  const parsed = URL.parse(url)
  if (!parsed || parsed.origin !== origin) return undefined
  if (parsed.pathname !== "/account" && parsed.pathname !== "/account/") return "external"
  const plan = parsed.searchParams.get("model_plan")
  const topup = parsed.searchParams.get("model_topup")
  if (plan === "success" || topup === "success" || plan === "updated" || plan === "ending") return "completed"
  if (plan === "cancelled" || topup === "cancelled") return "cancelled"
  return "closed"
}

/** The window has no address bar, so its title names the page's host. */
export function billingTitle(url: string) {
  const host = URL.parse(url)?.hostname
  return host ? `Vector Codium billing: ${host}` : "Vector Codium billing"
}

function stripeHost(host: string) {
  return (
    host === "stripe.com" ||
    host.endsWith(".stripe.com") ||
    host === "stripe.network" ||
    host.endsWith(".stripe.network")
  )
}
