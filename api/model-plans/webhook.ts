import { recordCodiumCharge } from "../_lib/codium-ledger.js"
import { reconcileModelPlanAccount, readModelPlanAccount, type ReconcileHint } from "../_lib/model-plan-account.js"
import { modelPlanStripe, stripeRecord, verifyModelPlanWebhook } from "../_lib/model-plan-stripe.js"
import {
  ApiError,
  handleApiError,
  json,
  readRawBody,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"

export const config = { api: { bodyParser: false } }

/** What a dispute or early-fraud-warning notification is about, for reconcile to read again. */
function reconcileHint(event: Record<string, unknown>, data: Record<string, unknown>): ReconcileHint | undefined {
  const type = String(event.type)
  if (type.startsWith("charge.dispute.") && typeof data.charge === "string")
    return { kind: "dispute", charge: data.charge }
  if (type.startsWith("radar.early_fraud_warning.") && typeof data.id === "string")
    return { kind: "efw", id: data.id, ...(typeof data.charge === "string" ? { charge: data.charge } : {}) }
  return undefined
}

export async function reconcileModelPlanEvent(event: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  const data = stripeRecord(event.data) && stripeRecord(event.data.object) ? event.data.object : undefined
  if (
    !data ||
    !/^(checkout\.session\.|customer\.subscription\.|invoice\.|charge\.|payment_intent\.|radar\.early_fraud_warning\.)/.test(
      String(event.type),
    )
  )
    return
  const object =
    typeof data.customer === "string"
      ? data
      : typeof data.charge === "string"
        ? await modelPlanStripe(`charges/${encodeURIComponent(data.charge)}`, {}, fetcher)
        : undefined
  if (!object || typeof object.customer !== "string") return
  const customer = await modelPlanStripe(`customers/${encodeURIComponent(object.customer)}`, {}, fetcher)
  const id = stripeRecord(customer.metadata) ? customer.metadata.vector_account_id : undefined
  if (typeof id !== "string") return
  const account = await readModelPlanAccount(id, fetcher)
  if (account?.customer !== object.customer)
    throw new ApiError(400, "BILLING_ACCOUNT_MISMATCH", "The billing account does not match.")
  // Codium sells monthly plans only, so a completed one-time payment checkout grants nothing of its own.
  // Read current Stripe state instead of applying webhook deltas: event retries
  // and out-of-order refund/dispute notifications cannot grant credits twice. A dispute or fraud warning on a charge
  // no subscription points at any more (last month's) is named to reconcile, which reads it again from Stripe.
  await reconcileModelPlanAccount(id, fetcher, Date.now(), { source: "webhook", hint: reconcileHint(event, data) })
  const charge = /^charge\.(dispute|refund)\./.test(String(event.type))
    ? data.charge
    : String(event.type).startsWith("charge.")
      ? data.id
      : String(event.type).startsWith("invoice.")
        ? data.charge
        : String(event.type).startsWith("payment_intent.")
          ? data.latest_charge
          : undefined
  // The private profit ledger rewrites the charge's entry from Stripe's current state on each notification about it.
  if (typeof charge === "string" && /^(ch|py)_[a-zA-Z0-9]+$/.test(charge)) await recordCodiumCharge(id, charge, fetcher)
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    const event = verifyModelPlanWebhook(
      await readRawBody(request, 1_000_000),
      String(request.headers["stripe-signature"] ?? ""),
    )
    await reconcileModelPlanEvent(event)
    json(response, 200, { received: true })
  } catch (error) {
    handleApiError(response, error)
  }
}
