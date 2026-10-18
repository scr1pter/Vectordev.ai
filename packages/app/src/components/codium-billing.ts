import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import type { VectorBillingRequest, VectorBillingResult } from "@/vector-account"

export type BillingNotice = { kind: "done" | "info" | "error"; text: string }

const price = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

/** What to tell the person once Vector's billing window is done; nothing when they only looked and closed it. */
export function billingNotice(request: VectorBillingRequest, result: VectorBillingResult): BillingNotice | undefined {
  if (result.outcome === "failed") return { kind: "error", text: result.message }
  if (result.outcome === "website") return { kind: "info", text: "This continues on vectordev.ai in your browser." }
  if (result.outcome === "cancelled") return { kind: "info", text: "Checkout was cancelled. Nothing was charged." }
  if (result.outcome === "closed") return undefined
  if (request.kind === "checkout")
    return { kind: "done", text: "You are subscribed. Your monthly credits appear here in a moment." }
  if (request.kind === "topup") return { kind: "done", text: "Your credits are bought. They appear here in a moment." }
  if (request.flow === "change") return { kind: "done", text: "Your plan change is saved." }
  if (request.flow === "cancel")
    return { kind: "done", text: "Your plan is cancelled. It keeps working until the end of this billing period." }
  return undefined
}

/**
 * What an offer's button does. Nothing can be bought while Codium is not on sale, so every button then reads "Coming
 * soon". A subscriber changes plans in Stripe's portal (one Change plan button), so other plans show no button.
 */
export function offerAction(
  offer: ModelPlanStatus.Offer,
  kind: "plan" | "topup",
  plan?: { id: string },
): { label: string; request?: VectorBillingRequest; current?: true } | undefined {
  if (kind === "plan" && plan?.id === offer.id) return { label: "Current plan", current: true }
  if (!offer.available) return { label: "Coming soon" }
  if (kind === "topup") return { label: "Buy", request: { kind: "topup", pack: offer.id } }
  if (plan) return undefined
  return { label: "Subscribe", request: { kind: "checkout", plan: offer.id } }
}

/** "$50 a month" or "$50 once": the public price, never the credits it buys. */
export function offerPrice(offer: ModelPlanStatus.Offer, kind: "plan" | "topup") {
  return `${price.format(offer.price)} ${kind === "plan" ? "a month" : "once"}`
}
