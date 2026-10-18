import { requireAccountUser } from "./account.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "./abuse.js"
import { modelPlanCheckout, modelPlanPortal, modelTopupCheckout } from "./model-plan-account.js"
import { requireModelPlanUser } from "./model-plan-chat.js"
import { modelPlansEnabled, requireModelPlans, requireModelTopups } from "./model-plan-config.js"
import { ApiError, handleApiError, json, readJson, requireMethod, type ApiRequest, type ApiResponse } from "./http.js"

/**
 * The account a Codium status or billing request acts for. The website signs in with a browser session. The desktop
 * app's main process holds the signed Vector account token instead, verified and checked against revocation exactly
 * as model requests are, so it can open checkout and the billing portal in its own window. Deleting the account never
 * accepts that token (see api/account/delete.ts).
 */
export async function requireBillingUser(request: ApiRequest, fetcher: typeof fetch = fetch) {
  return /^Bearer vct_/.test(String(request.headers.authorization ?? ""))
    ? requireModelPlanUser(request, fetcher)
    : requireAccountUser(request, fetcher)
}

export async function handleModelPlanCheckout(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    requireModelPlans()
    const account = await requireBillingUser(request, fetcher)
    await enforceRateLimit(request, response, {
      scope: "model-plan-checkout",
      identifier: account.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const body = await readJson<{ plan?: unknown }>(request, 4096)
    if (typeof body.plan !== "string")
      throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Vector model plan.")
    json(response, 200, await modelPlanCheckout(account, body.plan, fetcher))
  } catch (error) {
    handleApiError(response, error)
  }
}

export async function handleModelTopupCheckout(
  request: ApiRequest,
  response: ApiResponse,
  fetcher: typeof fetch = fetch,
) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    requireModelTopups()
    const account = await requireBillingUser(request, fetcher)
    await enforceRateLimit(request, response, {
      scope: "model-topup-checkout",
      identifier: account.id,
      limit: 10,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    const body = await readJson<{ pack?: unknown }>(request, 4096)
    if (typeof body.pack !== "string")
      throw new ApiError(400, "MODEL_TOPUP_INVALID", "Choose an available Codium credit pack.")
    json(response, 200, await modelTopupCheckout(account, body.pack, fetcher))
  } catch (error) {
    handleApiError(response, error)
  }
}

export async function handleModelPlanPortal(request: ApiRequest, response: ApiResponse, fetcher: typeof fetch = fetch) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 4096)
    // Keep cancellation reachable even when new model requests are disabled.
    if (!modelPlansEnabled() && !process.env.STRIPE_SECRET_KEY)
      throw new ApiError(503, "BILLING_UNAVAILABLE", "Billing is temporarily unavailable.")
    const account = await requireBillingUser(request, fetcher)
    await enforceRateLimit(request, response, {
      scope: "model-plan-portal",
      identifier: account.id,
      limit: 20,
      windowSeconds: 3600,
      requirePersistent: true,
    })
    // The website sends no body and opens the portal's home; Vector can ask for the plan change or cancel step.
    const flow = (await readJson<{ flow?: unknown } | null>(request, 4096))?.flow
    if (flow !== undefined && flow !== "change" && flow !== "cancel")
      throw new ApiError(400, "BILLING_FLOW_INVALID", "Choose plan changes or cancellation.")
    json(response, 200, await modelPlanPortal(account.id, fetcher, { flow }))
  } catch (error) {
    handleApiError(response, error)
  }
}
