import { handleStripeEvent, stripeClient } from "../_lib/billing.js"
import {
  ApiError,
  handleApiError,
  json,
  readRawBody,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import type Stripe from "stripe"

export const config = { api: { bodyParser: false } }

type WebhookDependencies = {
  constructEvent: (payload: Buffer, signature: string, secret: string) => Stripe.Event
  handleEvent: typeof handleStripeEvent
}

export async function handleWebhook(request: ApiRequest, response: ApiResponse, dependencies?: WebhookDependencies) {
  try {
    requireMethod(request, "POST")
    const signature = request.headers["stripe-signature"]
    if (typeof signature !== "string") throw new ApiError(400, "SIGNATURE_REQUIRED", "Stripe signature is missing.")
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (!secret) throw new ApiError(503, "BILLING_NOT_CONFIGURED", "Vector billing is not configured.")
    const payload = await readRawBody(request)
    const event = dependencies
      ? dependencies.constructEvent(payload, signature, secret)
      : stripeClient().webhooks.constructEvent(payload, signature, secret)
    // Stripe counts any non-2xx as a failed delivery and disables an endpoint
    // after sustained failures. Acknowledge only Stripe objects Vector
    // deliberately ignores. Provisioning, metadata, and email failures must
    // remain retryable even when their domain error would be a 4xx elsewhere.
    try {
      await (dependencies?.handleEvent ?? handleStripeEvent)(event)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "STRIPE_OBJECT_IGNORED") {
        json(response, 200, { received: true, ignored: true })
        return
      }
      console.error("Stripe webhook handler failed", event.type, event.id, cause)
      throw new ApiError(500, "WEBHOOK_PROCESSING_FAILED", "Vector could not process this Stripe event.")
    }
    json(response, 200, { received: true })
  } catch (error) {
    handleApiError(response, error)
  }
}

export default handleWebhook
