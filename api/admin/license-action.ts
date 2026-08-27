import { actionPatch, isOperatorAction, requireOperator, toOperatorLicence } from "../_lib/admin.js"
import { stripeClient } from "../_lib/billing.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "../_lib/http.js"

// POST /api/admin/license-action
//   { customerId, action: "release-device" | "revoke" | "restore" | "extend-grace", days?, reason? }
//
// Every action is a metadata patch on the Stripe customer, because Stripe stays
// the single source of truth for licensing — there is no second database to
// drift out of sync with it.
export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireOperator(request)
    const body = await readJson<{ customerId?: string; action?: string; days?: number; reason?: string }>(request)

    const customerId = body.customerId?.trim()
    if (!customerId) throw new ApiError(400, "CUSTOMER_REQUIRED", "Name the customer this action applies to.")
    if (!isOperatorAction(body.action)) {
      throw new ApiError(400, "ACTION_INVALID", "Unknown action. Use release-device, revoke, restore or extend-grace.")
    }

    const stripe = stripeClient()
    const existing = await stripe.customers.retrieve(customerId)
    if (!existing || existing.deleted) {
      throw new ApiError(404, "LICENSE_NOT_FOUND", "No Vector licence for that customer.")
    }

    const now = new Date()
    const patch = actionPatch({ action: body.action, now, days: body.days })
    // A short operator note travels with the record, so a revoked licence can
    // always be explained later without a separate audit store.
    const reason = body.reason?.trim().slice(0, 300)
    const updated = await stripe.customers.update(customerId, {
      metadata: {
        ...patch,
        vector_admin_last_action: body.action,
        vector_admin_last_action_at: now.toISOString(),
        ...(reason ? { vector_admin_last_reason: reason } : {}),
      },
    })

    json(response, 200, { licence: toOperatorLicence(updated, now), action: body.action })
  } catch (error) {
    handleApiError(response, error)
  }
}
