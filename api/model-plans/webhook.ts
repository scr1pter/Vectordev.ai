import { reconcileModelPlanAccount, reconcileModelTopup, readModelPlanAccount } from "../_lib/model-plan-account.js"
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

export async function reconcileModelPlanEvent(event: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  const data = stripeRecord(event.data) && stripeRecord(event.data.object) ? event.data.object : undefined
  if (
    !data ||
    !/^(checkout\.session\.|customer\.subscription\.|invoice\.|charge\.|payment_intent\.)/.test(String(event.type))
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
  if (
    String(event.type).startsWith("checkout.session.") &&
    typeof data.id === "string" &&
    data.mode === "payment" &&
    data.status === "complete"
  )
    await reconcileModelTopup(id, data.id, fetcher)
  // Read current Stripe state instead of applying webhook deltas: event retries
  // and out-of-order refund/dispute notifications cannot grant credits twice.
  await reconcileModelPlanAccount(id, fetcher)
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
