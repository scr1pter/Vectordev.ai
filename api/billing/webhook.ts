import { handleStripeEvent, stripeClient } from "../_lib/billing.js"
import { ApiError, handleApiError, json, readRawBody, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

export const config = { api: { bodyParser: false } }

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const signature = request.headers["stripe-signature"]
    if (typeof signature !== "string") throw new ApiError(400, "SIGNATURE_REQUIRED", "Stripe signature is missing.")
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Vector billing is not configured.")
    const event = stripeClient().webhooks.constructEvent(await readRawBody(request), signature, secret)
    // Stripe counts any non-2xx as a failed delivery and disables an endpoint
    // after sustained failures — which would silently stop all provisioning and
    // all license email. Events Vector deliberately ignores (a subscription
    // that is not a Vector product, an unrecognised plan) throw
    // STRIPE_OBJECT_IGNORED, and a genuine handler fault should be retried by
    // Stripe rather than counted against the endpoint. Acknowledge everything
    // that passed signature verification and log the rest.
    await handleStripeEvent(event).catch((cause: unknown) => {
      console.error("Stripe webhook handler failed", event.type, event.id, cause)
    })
    json(response, 200, { received: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
