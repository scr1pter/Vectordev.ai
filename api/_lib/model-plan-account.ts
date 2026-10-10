import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import type { AccountUser } from "./account.js"
import { withBillingMutation } from "./billing-lock.js"
import { modelPlanOrigin, modelPlans, modelTopups, MODEL_PLAN_ROOT } from "./model-plan-config.js"
import { modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

const Account = Schema.Struct({
  customer: Schema.String,
  closing: Schema.optional(Schema.Boolean),
  checkout: Schema.optional(
    Schema.Struct({ id: Schema.String, plan: Schema.String, url: Schema.String, expires: Schema.Number }),
  ),
  topupCheckout: Schema.optional(
    Schema.Struct({ id: Schema.String, plan: Schema.String, url: Schema.String, expires: Schema.Number }),
  ),
  purchases: Schema.optional(
    Schema.Array(
      Schema.Struct({
        checkout: Schema.String,
        payment: Schema.String,
        price: Schema.Number,
        credits: Schema.Number,
      }),
    ),
  ),
  wallet: Schema.optional(Schema.Struct({ hash: Schema.String, encrypted: Schema.String })),
  key: Schema.optional(
    Schema.Struct({
      hash: Schema.String,
      encrypted: Schema.String,
      subscription: Schema.String,
      start: Schema.Number,
      end: Schema.Number,
      credits: Schema.Number,
    }),
  ),
})
type Account = typeof Account.Type
const accountKey = (id: string) => `vector:model-plans:account:${id}`

export async function readModelPlanAccount(id: string, fetcher: typeof fetch = fetch) {
  const saved = await persistentStore(["GET", accountKey(id)], fetcher)
  if (saved === null) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Account))(saved)
  if (Option.isNone(decoded))
    throw new ApiError(503, "MODEL_PLAN_ACCOUNT_INVALID", "Model access could not be verified.")
  return decoded.value
}

async function saveAccount(id: string, value: Account, fetcher: typeof fetch) {
  await persistentStore(["SET", accountKey(id), JSON.stringify(value)], fetcher)
}

export async function openRouterManagement(
  path: string,
  body?: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  method = "GET",
) {
  const response = await fetcher(`${MODEL_PLAN_ROOT}/keys${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY ?? ""}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  })
  const result: unknown = await response.json().catch(() => undefined)
  if (!response.ok || !stripeRecord(result))
    throw new ApiError(503, "MODEL_PLAN_UPSTREAM", "Your model allowance is temporarily unavailable.")
  return result
}

export function protectModelPlanKey(value: string, context: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv)
  cipher.setAAD(Buffer.from(context))
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")
}

export function revealModelPlanKey(value: string, context: string) {
  const bytes = Buffer.from(value, "base64url")
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(context))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")
}

function encryptionKey() {
  const key = process.env.MODEL_PLAN_KEY_ENCRYPTION_SECRET ?? ""
  if (!/^[a-fA-F0-9]{64}$/.test(key))
    throw new ApiError(503, "MODEL_PLAN_ENCRYPTION", "Vector Codium is temporarily unavailable.")
  return Buffer.from(key, "hex")
}

function verifiedUsage(value: unknown) {
  return stripeRecord(value) && typeof value.usage === "number" && Number.isFinite(value.usage) && value.usage >= 0
    ? value.usage
    : undefined
}

function topupPaymentCredits(
  payment: unknown,
  account: Account,
  id: string,
  purchase: NonNullable<Account["purchases"]>[number],
) {
  if (
    !stripeRecord(payment) ||
    payment.id !== purchase.payment ||
    payment.customer !== account.customer ||
    payment.status !== "succeeded" ||
    payment.currency !== "usd" ||
    payment.amount !== purchase.price * 100 ||
    payment.amount_received !== purchase.price * 100 ||
    !stripeRecord(payment.metadata) ||
    payment.metadata.vector_account_id !== id ||
    payment.metadata.vector_product !== "codium-topup"
  )
    return 0
  const charge = payment.latest_charge
  if (
    !stripeRecord(charge) ||
    charge.paid !== true ||
    charge.disputed !== false ||
    charge.currency !== "usd" ||
    charge.amount !== purchase.price * 100 ||
    typeof charge.amount_refunded !== "number" ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < 0 ||
    charge.amount_refunded > charge.amount
  )
    return 0
  // Refunded/disputed spending remains in provider usage, so future purchases
  // cannot recreate credits that were already consumed before a reversal.
  return (
    Math.floor((Math.round(purchase.credits * 100) * (charge.amount - charge.amount_refunded)) / charge.amount) / 100
  )
}

async function purchasedCredits(account: Account, id: string, fetcher: typeof fetch) {
  const purchases = account.purchases ?? []
  // Keep payment verification authoritative without allowing a long-lived
  // wallet to fan out an unbounded number of Stripe requests simultaneously.
  const batches = Array.from({ length: Math.ceil(purchases.length / 8) }, (_, index) =>
    purchases.slice(index * 8, (index + 1) * 8),
  )
  const cents = await batches.reduce(async (previous, batch) => {
    const total = await previous
    const values = await Promise.all(
      batch.map(async (purchase) => {
        const payment = await modelPlanStripe(
          `payment_intents/${encodeURIComponent(purchase.payment)}?expand[]=latest_charge`,
          {},
          fetcher,
        )
        const charge = stripeRecord(payment.latest_charge) ? payment.latest_charge : undefined
        const available = charge && (await chargeAvailable(charge, { payment_intent: purchase.payment }, fetcher))
        return topupPaymentCredits(
          available ? { ...payment, latest_charge: { ...charge, disputed: false } } : payment,
          account,
          id,
          purchase,
        )
      }),
    )
    return total + values.reduce((sum, value) => sum + Math.round(value * 100), 0)
  }, Promise.resolve(0))
  return cents / 100
}

async function chargeAvailable(
  charge: Record<string, unknown>,
  filter: { charge?: string; payment_intent?: string },
  fetcher: typeof fetch,
) {
  if (charge.disputed === false) return true
  if (charge.disputed !== true || (!filter.charge && !filter.payment_intent)) return false
  const query = new URLSearchParams({ ...filter, limit: "100" })
  const result = await modelPlanStripe(`disputes?${query}`, {}, fetcher)
  // Charge.disputed is historical, so a resolved dispute can retain true.
  // Restore only conclusively merchant-won/closed-inquiry payments. Unknown,
  // pending, lost, truncated, and mismatched results all remain unavailable.
  return (
    result.has_more === false &&
    Array.isArray(result.data) &&
    result.data.length > 0 &&
    result.data.every(
      (value) =>
        stripeRecord(value) &&
        ["won", "warning_closed"].includes(String(value.status)) &&
        (!filter.charge || value.charge === filter.charge) &&
        (!filter.payment_intent || value.payment_intent === filter.payment_intent),
    )
  )
}

async function settlePendingTopup(id: string, fetcher: typeof fetch) {
  const account = await readModelPlanAccount(id, fetcher)
  if (
    !account?.topupCheckout ||
    account.closing ||
    account.purchases?.some((value) => value.checkout === account.topupCheckout?.id)
  )
    return
  const session = await modelPlanStripe(
    `checkout/sessions/${encodeURIComponent(account.topupCheckout.id)}`,
    {},
    fetcher,
  )
  if (session.status === "complete") await reconcileModelTopup(id, account.topupCheckout.id, fetcher)
}

export async function reconcileModelTopup(id: string, checkoutID: string, fetcher: typeof fetch = fetch) {
  return withBillingMutation(
    `model-plan:${id}`,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) throw new ApiError(400, "BILLING_ACCOUNT_MISMATCH", "The billing account does not match.")
      if (account.closing) return
      const query = new URLSearchParams({
        "expand[0]": "payment_intent.latest_charge",
        "expand[1]": "line_items.data.price",
      })
      const session = await modelPlanStripe(`checkout/sessions/${encodeURIComponent(checkoutID)}?${query}`, {}, fetcher)
      const metadata = stripeRecord(session.metadata) ? session.metadata : undefined
      if (metadata?.vector_product !== "codium-topup") return
      const pack = modelTopups().find((value) => value.id === metadata.vector_pack)
      const credits = Number(metadata.vector_credits_usd)
      const lines = stripeRecord(session.line_items) ? session.line_items.data : undefined
      const line = Array.isArray(lines) && lines.length === 1 && stripeRecord(lines[0]) ? lines[0] : undefined
      const price = line && stripeRecord(line.price) ? line.price : undefined
      const payment = stripeRecord(session.payment_intent) ? session.payment_intent : undefined
      if (
        session.id !== checkoutID ||
        session.customer !== account.customer ||
        session.client_reference_id !== id ||
        metadata.vector_account_id !== id ||
        !pack ||
        !Number.isFinite(credits) ||
        credits <= 0 ||
        credits > pack.price ||
        Math.abs(Math.round(credits * 100) - credits * 100) > 0.000001 ||
        session.mode !== "payment" ||
        session.status !== "complete" ||
        session.payment_status !== "paid" ||
        session.currency !== "usd" ||
        session.amount_total !== pack.price * 100 ||
        line?.quantity !== 1 ||
        price?.id !== metadata.vector_price_id ||
        price?.currency !== "usd" ||
        price.unit_amount !== pack.price * 100 ||
        price.recurring ||
        typeof payment?.id !== "string"
      )
        throw new ApiError(400, "MODEL_TOPUP_PAYMENT_INVALID", "This credit purchase could not be verified.")
      const purchase = { checkout: checkoutID, payment: payment.id, price: pack.price, credits }
      // A fully refunded purchase still has to be recorded. Its zero grant and
      // original identity survive retries and a later dispute resolution.
      if (
        payment.customer !== account.customer ||
        payment.amount !== pack.price * 100 ||
        payment.amount_received !== pack.price * 100 ||
        payment.status !== "succeeded"
      )
        throw new ApiError(400, "MODEL_TOPUP_PAYMENT_INVALID", "This credit purchase could not be verified.")
      const existing = account.purchases?.find((value) => value.checkout === checkoutID || value.payment === payment.id)
      if (
        existing &&
        (existing.checkout !== checkoutID ||
          existing.payment !== purchase.payment ||
          existing.price !== purchase.price ||
          existing.credits !== purchase.credits)
      )
        throw new ApiError(
          409,
          "MODEL_TOPUP_PAYMENT_CONFLICT",
          "This credit purchase was already recorded differently.",
        )
      const updated = existing ? account : { ...account, purchases: [...(account.purchases ?? []), purchase] }
      await verify()
      if (!existing) await saveAccount(id, updated, fetcher)
      if (updated.wallet) await synchronizeWalletKey(id, updated, fetcher, verify)
    },
    fetcher,
  )
}

async function synchronizeWalletKey(id: string, account: Account, fetcher: typeof fetch, verify: () => Promise<void>) {
  if (!account.wallet) return
  const credits = await purchasedCredits(account, id, fetcher)
  const result = await openRouterManagement(`/${encodeURIComponent(account.wallet.hash)}`, undefined, fetcher)
  const usage = verifiedUsage(result.data)
  if (usage === undefined)
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your purchased credits could not be verified.")
  await verify()
  await openRouterManagement(
    `/${encodeURIComponent(account.wallet.hash)}`,
    {
      disabled: account.closing === true || credits <= usage,
      limit: credits,
      limit_reset: null,
      include_byok_in_limit: true,
      expires_at: null,
    },
    fetcher,
    "PATCH",
  )
}

async function walletCredential(id: string, fetcher: typeof fetch, requiredCredits: number) {
  await settlePendingTopup(id, fetcher)
  const existing = await readModelPlanAccount(id, fetcher)
  if (existing?.closing)
    throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
  if (existing?.wallet) {
    const credits = await purchasedCredits(existing, id, fetcher)
    const result = await openRouterManagement(`/${encodeURIComponent(existing.wallet.hash)}`, undefined, fetcher)
    const key = result.data
    const usage = verifiedUsage(key)
    if (
      stripeRecord(key) &&
      usage !== undefined &&
      key.disabled === false &&
      key.limit === credits &&
      key.limit_reset === null &&
      key.include_byok_in_limit === true &&
      key.expires_at === null
    ) {
      if (credits <= usage || credits - usage < requiredCredits)
        throw new ApiError(
          402,
          "MODEL_TOPUP_EXHAUSTED",
          "Your purchased credits cannot cover this request's maximum cost. Shorten the context or response, or add credits.",
        )
      return revealModelPlanKey(existing.wallet.encrypted, `${id}:wallet`)
    }
  }
  return withBillingMutation(
    `model-plan:${id}`,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account || account.closing)
        throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Codium subscription or add credits to use this model.")
      const credits = await purchasedCredits(account, id, fetcher)
      if (account.wallet) {
        await synchronizeWalletKey(id, account, fetcher, verify)
        const result = await openRouterManagement(`/${encodeURIComponent(account.wallet.hash)}`, undefined, fetcher)
        const usage = verifiedUsage(result.data)
        if (usage === undefined)
          throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your purchased credits could not be verified.")
        if (credits <= usage || credits - usage < requiredCredits)
          throw new ApiError(
            402,
            "MODEL_TOPUP_EXHAUSTED",
            "Your purchased credits cannot cover this request's maximum cost. Shorten the context or response, or add credits.",
          )
        return revealModelPlanKey(account.wallet.encrypted, `${id}:wallet`)
      }
      if (credits <= 0 || credits < requiredCredits)
        throw new ApiError(402, "MODEL_TOPUP_EXHAUSTED", "Add purchased credits to cover this request's maximum cost.")
      await verify()
      const result = await openRouterManagement(
        "",
        {
          name: `Codium ${id} purchased credits`,
          limit: credits,
          limit_reset: null,
          include_byok_in_limit: true,
          expires_at: null,
        },
        fetcher,
        "POST",
      )
      if (
        !stripeRecord(result.data) ||
        typeof result.data.hash !== "string" ||
        typeof result.key !== "string" ||
        !result.key
      )
        throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your purchased-credit allowance could not be created.")
      await saveAccount(
        id,
        { ...account, wallet: { hash: result.data.hash, encrypted: protectModelPlanKey(result.key, `${id}:wallet`) } },
        fetcher,
      )
      return result.key
    },
    fetcher,
  )
}

export async function reconcileModelPlanAccount(id: string, fetcher: typeof fetch = fetch) {
  await settlePendingTopup(id, fetcher)
  await withBillingMutation(
    `model-plan:${id}`,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) return
      const paid = account.closing
        ? []
        : (await subscriptions(account.customer, fetcher)).filter((value) => paidModelPlan(value, id))
      if (account.key && paid.length !== 1) {
        await verify()
        await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
      }
      if (account.wallet) await synchronizeWalletKey(id, account, fetcher, verify)
    },
    fetcher,
  )
}

export function paidModelPlan(subscription: unknown, accountID: string, now = Date.now()) {
  if (
    !stripeRecord(subscription) ||
    typeof subscription.id !== "string" ||
    subscription.status !== "active" ||
    subscription.pause_collection
  )
    return undefined
  const metadata = stripeRecord(subscription.metadata) ? subscription.metadata : undefined
  const items = stripeRecord(subscription.items) ? subscription.items.data : undefined
  if (
    metadata?.vector_account_id !== accountID ||
    !Array.isArray(items) ||
    items.length !== 1 ||
    !stripeRecord(items[0])
  )
    return undefined
  const item = items[0]
  const price = stripeRecord(item.price) ? item.price : undefined
  const recurring = price && stripeRecord(price.recurring) ? price.recurring : undefined
  const configured = modelPlans().find((plan) => plan.priceID && plan.priceID === price?.id)
  const credits =
    metadata?.vector_model_credits_usd === undefined ? configured?.credits : Number(metadata.vector_model_credits_usd)
  const plan =
    configured && credits !== undefined && Number.isFinite(credits) && credits > 0 && credits <= configured.price
      ? { ...configured, credits }
      : undefined
  if (
    !plan?.credits ||
    item.quantity !== 1 ||
    price?.currency !== "usd" ||
    price.unit_amount !== plan.price * 100 ||
    recurring?.interval !== "month" ||
    recurring.interval_count !== 1
  )
    return undefined
  const start = Number(item.current_period_start ?? subscription.current_period_start)
  const end = Number(item.current_period_end ?? subscription.current_period_end)
  const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start * 1000 > now ||
    end * 1000 <= now ||
    end <= start ||
    invoice?.paid !== true ||
    invoice.status !== "paid"
  )
    return undefined
  const charge = stripeRecord(invoice.charge) ? invoice.charge : undefined
  if (
    typeof invoice.amount_paid !== "number" ||
    invoice.amount_paid < plan.price * 100 ||
    !charge ||
    charge.paid !== true ||
    charge.refunded !== false ||
    charge.disputed !== false ||
    charge.amount_refunded !== 0
  )
    return undefined
  // An old paid invoice must not grant a newly changed billing period or an unpaid upgrade.
  const lines = stripeRecord(invoice.lines) ? invoice.lines.data : undefined
  if (
    !Array.isArray(lines) ||
    !lines.some(
      (line) =>
        stripeRecord(line) &&
        stripeRecord(line.price) &&
        line.price.id === price.id &&
        stripeRecord(line.period) &&
        line.period.start === start &&
        line.period.end === end &&
        line.proration !== true,
    )
  )
    return undefined
  return { id: subscription.id, plan, start, end, cancelAtPeriodEnd: subscription.cancel_at_period_end === true }
}

async function subscriptions(customer: string, fetcher: typeof fetch) {
  const query = new URLSearchParams({ customer, status: "all", limit: "100", "expand[]": "data.latest_invoice.charge" })
  const result = await modelPlanStripe(`subscriptions?${query}`, {}, fetcher)
  if (!Array.isArray(result.data) || result.has_more === true)
    throw new ApiError(503, "MODEL_PLAN_SUBSCRIPTIONS", "Your subscription could not be verified.")
  return Promise.all(
    result.data.filter(stripeRecord).map(async (subscription) => {
      const invoice = stripeRecord(subscription.latest_invoice) ? subscription.latest_invoice : undefined
      const charge = invoice && stripeRecord(invoice.charge) ? invoice.charge : undefined
      if (
        !charge ||
        charge.disputed !== true ||
        typeof charge.id !== "string" ||
        !(await chargeAvailable(charge, { charge: charge.id }, fetcher))
      )
        return subscription
      return { ...subscription, latest_invoice: { ...invoice, charge: { ...charge, disputed: false } } }
    }),
  )
}

export async function modelPlanStatus(id: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  await settlePendingTopup(id, fetcher)
  const account = await readModelPlanAccount(id, fetcher)
  const monthly = await monthlyStatus(id, fetcher, now)
  if (!account || account.closing) return { ...monthly, access: false, wallet: { credits: 0, used: 0, remaining: 0 } }
  const credits = await purchasedCredits(account, id, fetcher)
  const data = account.wallet
    ? (await openRouterManagement(`/${encodeURIComponent(account.wallet.hash)}`, undefined, fetcher)).data
    : undefined
  const used = account.wallet ? verifiedUsage(data) : 0
  const remaining = used === undefined ? undefined : Math.max(0, credits - used)
  return {
    ...monthly,
    customer: true,
    access: monthly.active || (remaining !== undefined && remaining > 0),
    wallet: { credits, used, remaining },
  }
}

export async function modelPlanCredential(
  id: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  requiredCredits = 0,
) {
  // Only choose a funding pool before starting inference. A provider error may
  // already represent billable work and must never trigger a second request.
  try {
    return await monthlyCredential(id, fetcher, now, requiredCredits)
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      !["MODEL_PLAN_REQUIRED", "MODEL_PLAN_PAYMENT_REQUIRED", "MODEL_PLAN_EXHAUSTED"].includes(error.code)
    )
      throw error
    const account = await readModelPlanAccount(id, fetcher)
    if (!account?.topupCheckout && !account?.purchases?.length) throw error
    return walletCredential(id, fetcher, requiredCredits)
  }
}

async function monthlyStatus(id: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const account = await readModelPlanAccount(id, fetcher)
  if (!account) return { active: false as const }
  if (account.closing) return { active: false as const, customer: true }
  const all = await subscriptions(account.customer, fetcher)
  const eligible = all
    .map((subscription) => paidModelPlan(subscription, id, now))
    .filter((value) => value !== undefined)
  if (eligible.length !== 1) return { active: false as const, customer: true }
  const paid = eligible[0]
  const current = account.key?.subscription === paid.id && account.key.start === paid.start ? account.key : undefined
  const data = current
    ? (await openRouterManagement(`/${encodeURIComponent(current.hash)}`, undefined, fetcher)).data
    : undefined
  const usage =
    stripeRecord(data) && typeof data.usage === "number" && Number.isFinite(data.usage) && data.usage >= 0
      ? data.usage
      : current
        ? undefined
        : 0
  return {
    active: true as const,
    plan: paid.plan.id,
    credits: paid.plan.credits,
    used: usage,
    remaining: usage === undefined ? undefined : Math.max(0, paid.plan.credits - usage),
    periodStart: paid.start * 1000,
    periodEnd: paid.end * 1000,
    cancelAtPeriodEnd: paid.cancelAtPeriodEnd,
  }
}

async function monthlyCredential(id: string, fetcher: typeof fetch, now: number, requiredCredits: number) {
  // Normal parallel agent turns only read the existing entitlement/key. Serialize
  // provisioning and repairs, not every model request for the same account.
  const existing = await readModelPlanAccount(id, fetcher)
  if (existing?.closing)
    throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
  if (existing) {
    const eligible = (await subscriptions(existing.customer, fetcher))
      .map((subscription) => paidModelPlan(subscription, id, now))
      .filter((value) => value !== undefined)
    const paid = eligible.length === 1 ? eligible[0] : undefined
    if (!paid && !existing.key)
      throw new ApiError(
        402,
        "MODEL_PLAN_PAYMENT_REQUIRED",
        "Your model subscription needs an active paid billing period.",
      )
    if (!paid && existing.key) {
      const result = await openRouterManagement(`/${encodeURIComponent(existing.key.hash)}`, undefined, fetcher)
      if (stripeRecord(result.data) && result.data.disabled === true)
        throw new ApiError(
          402,
          "MODEL_PLAN_PAYMENT_REQUIRED",
          "Your model subscription needs an active paid billing period.",
        )
    }
    if (paid && existing.key?.subscription === paid.id && existing.key.start === paid.start) {
      const result = await openRouterManagement(`/${encodeURIComponent(existing.key.hash)}`, undefined, fetcher)
      const key = result.data
      if (
        stripeRecord(key) &&
        key.disabled === false &&
        key.limit === paid.plan.credits &&
        key.limit_reset === null &&
        key.include_byok_in_limit === true &&
        key.expires_at === new Date(paid.end * 1000).toISOString() &&
        typeof key.usage === "number" &&
        Number.isFinite(key.usage) &&
        key.usage >= 0
      ) {
        if (key.usage >= paid.plan.credits || paid.plan.credits - key.usage < requiredCredits)
          throw new ApiError(
            402,
            "MODEL_PLAN_EXHAUSTED",
            "Your included model credits are used up. They renew at the next billing period.",
          )
        return revealModelPlanKey(existing.key.encrypted, `${id}:${paid.id}:${paid.start}`)
      }
    }
  }
  return withBillingMutation(
    `model-plan:${id}`,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account)
        throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Codium subscription or add credits to use this model.")
      if (account.closing)
        throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
      const eligible = (await subscriptions(account.customer, fetcher))
        .map((subscription) => paidModelPlan(subscription, id, now))
        .filter((value) => value !== undefined)
      if (eligible.length !== 1) {
        if (account.key)
          await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
        throw new ApiError(
          402,
          "MODEL_PLAN_PAYMENT_REQUIRED",
          "Your model subscription needs an active paid billing period.",
        )
      }
      const paid = eligible[0]
      if (paid.plan.credits < requiredCredits)
        throw new ApiError(
          402,
          "MODEL_PLAN_EXHAUSTED",
          "The remaining monthly credits cannot cover this request's maximum cost. Shorten the context or response, or add a top-up.",
        )
      const context = `${id}:${paid.id}:${paid.start}`
      if (account.key?.subscription === paid.id && account.key.start === paid.start) {
        const result = await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, undefined, fetcher)
        const key = result.data
        if (
          !stripeRecord(key) ||
          typeof key.disabled !== "boolean" ||
          typeof key.usage !== "number" ||
          !Number.isFinite(key.usage) ||
          key.usage < 0
        )
          throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your model allowance could not be verified.")
        if (key.usage >= paid.plan.credits || paid.plan.credits - key.usage < requiredCredits)
          throw new ApiError(
            402,
            "MODEL_PLAN_EXHAUSTED",
            "Your included model credits are used up. They renew at the next billing period.",
          )
        if (
          key.disabled ||
          key.limit !== paid.plan.credits ||
          key.limit_reset !== null ||
          key.include_byok_in_limit !== true ||
          key.expires_at !== new Date(paid.end * 1000).toISOString()
        ) {
          await verify()
          await openRouterManagement(
            `/${encodeURIComponent(account.key.hash)}`,
            {
              disabled: false,
              limit: paid.plan.credits,
              limit_reset: null,
              include_byok_in_limit: true,
              expires_at: new Date(paid.end * 1000).toISOString(),
            },
            fetcher,
            "PATCH",
          )
        }
        return revealModelPlanKey(account.key.encrypted, context)
      }
      if (account.key)
        await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
      await verify()
      const result = await openRouterManagement(
        "",
        {
          name: `Vector ${id} ${paid.id} ${paid.start}`,
          limit: paid.plan.credits,
          limit_reset: null,
          include_byok_in_limit: true,
          expires_at: new Date(paid.end * 1000).toISOString(),
        },
        fetcher,
        "POST",
      )
      if (
        !stripeRecord(result.data) ||
        typeof result.data.hash !== "string" ||
        typeof result.key !== "string" ||
        !result.key
      )
        throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your model allowance could not be created.")
      await saveAccount(
        id,
        {
          ...account,
          key: {
            hash: result.data.hash,
            encrypted: protectModelPlanKey(result.key, context),
            subscription: paid.id,
            start: paid.start,
            end: paid.end,
            credits: paid.plan.credits,
          },
        },
        fetcher,
      )
      return result.key
    },
    fetcher,
  )
}

export async function modelPlanCheckout(
  user: AccountUser,
  planID: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const plan = modelPlans().find((plan) => plan.id === planID)
  if (!plan?.priceID || !plan.credits)
    throw new ApiError(400, "MODEL_PLAN_INVALID", "Choose an available Codium subscription.")
  return withBillingMutation(
    `model-plan:${user.id}`,
    async (verify) => {
      const previous = await readModelPlanAccount(user.id, fetcher)
      if (previous?.closing)
        throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Checkout is closed.")
      const customer =
        previous?.customer ??
        (
          await modelPlanStripe(
            "customers",
            {
              method: "POST",
              idempotency: `vector-model-customer-${user.id}`,
              body: new URLSearchParams({ email: user.email, "metadata[vector_account_id]": user.id }),
            },
            fetcher,
          )
        ).id
      if (typeof customer !== "string" || !/^cus_[a-zA-Z0-9]+$/.test(customer))
        throw new ApiError(502, "BILLING_CUSTOMER", "Your billing account could not be created.")
      const account = previous ?? { customer }
      if (!previous) await saveAccount(user.id, account, fetcher)
      if (
        (await subscriptions(customer, fetcher)).some(
          (subscription) => !["canceled", "incomplete_expired"].includes(String(subscription.status)),
        )
      )
        throw new ApiError(409, "MODEL_PLAN_EXISTS", "You already have a subscription. Manage it from your account.")
      if (account.checkout && account.checkout.expires > now) {
        const pending = await modelPlanStripe(
          `checkout/sessions/${encodeURIComponent(account.checkout.id)}`,
          {},
          fetcher,
        )
        if (pending.status === "complete")
          throw new ApiError(
            409,
            "MODEL_PLAN_EXISTS",
            "Checkout has already completed. Refresh your account or manage your subscription.",
          )
        if (
          pending.status === "open" &&
          account.checkout.plan === plan.id &&
          stripeRecord(pending.metadata) &&
          pending.metadata.vector_model_credits_usd === String(plan.credits) &&
          pending.metadata.vector_price_id === plan.priceID
        )
          return { url: account.checkout.url }
        if (pending.status === "open") {
          await verify()
          await modelPlanStripe(
            `checkout/sessions/${encodeURIComponent(account.checkout.id)}/expire`,
            { method: "POST" },
            fetcher,
          )
        }
      }
      const price = await modelPlanStripe(`prices/${plan.priceID}`, {}, fetcher)
      const recurring = stripeRecord(price.recurring) ? price.recurring : undefined
      if (
        price.active !== true ||
        price.currency !== "usd" ||
        price.unit_amount !== plan.price * 100 ||
        recurring?.interval !== "month" ||
        recurring.interval_count !== 1
      )
        throw new ApiError(503, "MODEL_PLAN_PRICE_MISMATCH", "This subscription price is not configured correctly.")
      await verify()
      const checkout = await modelPlanStripe(
        "checkout/sessions",
        {
          method: "POST",
          idempotency: `vector-model-checkout-${user.id}-${plan.id}-${createHash("sha256").update(`${plan.priceID}:${plan.credits}`).digest("hex").slice(0, 12)}-${account.checkout?.id ?? "new"}-${Math.floor(now / 1_800_000)}`,
          body: new URLSearchParams({
            mode: "subscription",
            "payment_method_types[0]": "card",
            customer,
            client_reference_id: user.id,
            "line_items[0][price]": plan.priceID,
            "line_items[0][quantity]": "1",
            "metadata[vector_model_credits_usd]": String(plan.credits),
            "metadata[vector_price_id]": plan.priceID,
            "subscription_data[metadata][vector_account_id]": user.id,
            "subscription_data[metadata][vector_plan]": plan.id,
            "subscription_data[metadata][vector_model_credits_usd]": String(plan.credits),
            success_url: `${modelPlanOrigin()}/account?model_plan=success`,
            cancel_url: `${modelPlanOrigin()}/account?model_plan=cancelled`,
            expires_at: String((Math.floor(now / 1_800_000) + 2) * 1_800),
          }),
        },
        fetcher,
      )
      if (
        typeof checkout.id !== "string" ||
        typeof checkout.url !== "string" ||
        !checkout.url.startsWith("https://checkout.stripe.com/") ||
        typeof checkout.expires_at !== "number"
      )
        throw new ApiError(502, "BILLING_CHECKOUT", "Checkout could not be opened.")
      await saveAccount(
        user.id,
        {
          ...account,
          checkout: { id: checkout.id, plan: plan.id, url: checkout.url, expires: checkout.expires_at * 1000 },
        },
        fetcher,
      )
      return { url: checkout.url }
    },
    fetcher,
  )
}

export async function modelPlanPortal(id: string, fetcher: typeof fetch = fetch) {
  const account = await readModelPlanAccount(id, fetcher)
  if (!account) throw new ApiError(404, "MODEL_PLAN_ACCOUNT_MISSING", "No Codium billing account exists yet.")
  const configuration = process.env.STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID?.trim()
  if (!configuration)
    throw new ApiError(503, "BILLING_PORTAL_UNAVAILABLE", "Subscription management is temporarily unavailable.")
  const result = await modelPlanStripe(
    "billing_portal/sessions",
    {
      method: "POST",
      body: new URLSearchParams({
        customer: account.customer,
        configuration,
        return_url: `${modelPlanOrigin()}/account`,
      }),
    },
    fetcher,
  )
  if (typeof result.url !== "string" || !result.url.startsWith("https://billing.stripe.com/"))
    throw new ApiError(502, "BILLING_PORTAL_UNAVAILABLE", "Subscription management could not be opened.")
  return { url: result.url }
}

export async function modelTopupCheckout(
  user: AccountUser,
  packID: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const pack = modelTopups().find((value) => value.id === packID)
  if (!pack?.priceID || !pack.credits)
    throw new ApiError(400, "MODEL_TOPUP_INVALID", "Choose an available Codium credit pack.")
  await settlePendingTopup(user.id, fetcher)
  return withBillingMutation(
    `model-plan:${user.id}`,
    async (verify) => {
      const previous = await readModelPlanAccount(user.id, fetcher)
      if (previous?.closing)
        throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Checkout is closed.")
      const customer =
        previous?.customer ??
        (
          await modelPlanStripe(
            "customers",
            {
              method: "POST",
              idempotency: `vector-model-customer-${user.id}`,
              body: new URLSearchParams({ email: user.email, "metadata[vector_account_id]": user.id }),
            },
            fetcher,
          )
        ).id
      if (typeof customer !== "string" || !/^cus_[a-zA-Z0-9]+$/.test(customer))
        throw new ApiError(502, "BILLING_CUSTOMER", "Your billing account could not be created.")
      const account = previous ?? { customer }
      if (!previous) await saveAccount(user.id, account, fetcher)
      if (account.topupCheckout && account.topupCheckout.expires > now) {
        const pending = await modelPlanStripe(
          `checkout/sessions/${encodeURIComponent(account.topupCheckout.id)}`,
          {},
          fetcher,
        )
        if (
          pending.status === "complete" &&
          !account.purchases?.some((value) => value.checkout === account.topupCheckout?.id)
        )
          throw new ApiError(
            409,
            "MODEL_TOPUP_PROCESSING",
            "Your last credit purchase is processing. Refresh your account and retry.",
          )
        if (
          pending.status === "open" &&
          account.topupCheckout.plan === pack.id &&
          stripeRecord(pending.metadata) &&
          pending.metadata.vector_credits_usd === String(pack.credits) &&
          pending.metadata.vector_price_id === pack.priceID
        )
          return { url: account.topupCheckout.url }
        if (pending.status === "open") {
          await verify()
          await modelPlanStripe(
            `checkout/sessions/${encodeURIComponent(account.topupCheckout.id)}/expire`,
            { method: "POST" },
            fetcher,
          )
        }
      }
      const price = await modelPlanStripe(`prices/${pack.priceID}`, {}, fetcher)
      if (
        price.active !== true ||
        price.currency !== "usd" ||
        price.unit_amount !== pack.price * 100 ||
        price.recurring
      )
        throw new ApiError(503, "MODEL_TOPUP_PRICE_MISMATCH", "This credit-pack price is not configured correctly.")
      const body = new URLSearchParams({
        mode: "payment",
        "payment_method_types[0]": "card",
        customer,
        client_reference_id: user.id,
        "line_items[0][price]": pack.priceID,
        "line_items[0][quantity]": "1",
        success_url: `${modelPlanOrigin()}/account?model_topup=success`,
        cancel_url: `${modelPlanOrigin()}/account?model_topup=cancelled`,
        expires_at: String((Math.floor(now / 1_800_000) + 2) * 1_800),
      })
      Object.entries({
        vector_account_id: user.id,
        vector_product: "codium-topup",
        vector_pack: pack.id,
        vector_credits_usd: String(pack.credits),
        vector_price_id: pack.priceID,
      }).forEach(([key, value]) => {
        body.set(`metadata[${key}]`, value)
        body.set(`payment_intent_data[metadata][${key}]`, value)
      })
      await verify()
      const checkout = await modelPlanStripe(
        "checkout/sessions",
        {
          method: "POST",
          idempotency: `vector-topup-checkout-${user.id}-${pack.id}-${createHash("sha256").update(`${pack.priceID}:${pack.credits}`).digest("hex").slice(0, 12)}-${account.topupCheckout?.id ?? "new"}-${Math.floor(now / 1_800_000)}`,
          body,
        },
        fetcher,
      )
      if (
        typeof checkout.id !== "string" ||
        typeof checkout.url !== "string" ||
        !checkout.url.startsWith("https://checkout.stripe.com/") ||
        typeof checkout.expires_at !== "number"
      )
        throw new ApiError(502, "BILLING_CHECKOUT", "Checkout could not be opened.")
      await saveAccount(
        user.id,
        {
          ...account,
          topupCheckout: { id: checkout.id, plan: pack.id, url: checkout.url, expires: checkout.expires_at * 1000 },
        },
        fetcher,
      )
      return { url: checkout.url }
    },
    fetcher,
  )
}

export async function cancelModelPlanAccount(id: string, fetcher: typeof fetch = fetch) {
  if (!process.env.STRIPE_SECRET_KEY?.trim()) {
    if (
      !process.env.KV_REST_API_URL?.trim() &&
      !process.env.UPSTASH_REDIS_REST_URL?.trim() &&
      process.env.MODEL_PLANS_ENABLED !== "true"
    )
      return
    if (await readModelPlanAccount(id, fetcher))
      throw new ApiError(503, "BILLING_UNAVAILABLE", "Model billing must be available before deleting this account.")
    return
  }
  await withBillingMutation(
    `model-plan:${id}`,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) return
      // Persist closure before external cleanup so retries cannot open new
      // checkout sessions or re-enable a key while identity deletion proceeds.
      await verify()
      await saveAccount(id, { ...account, closing: true }, fetcher)
      if (account.key)
        await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
      if (account.wallet)
        await openRouterManagement(`/${encodeURIComponent(account.wallet.hash)}`, { disabled: true }, fetcher, "PATCH")
      const query = new URLSearchParams({ customer: account.customer, status: "open", limit: "100" })
      const pending = await modelPlanStripe(`checkout/sessions?${query}`, {}, fetcher)
      if (!Array.isArray(pending.data) || pending.has_more === true)
        throw new ApiError(503, "MODEL_PLAN_CLEANUP", "Pending checkout sessions could not be closed. Retry deletion.")
      for (const session of pending.data) {
        if (!stripeRecord(session) || typeof session.id !== "string")
          throw new ApiError(
            503,
            "MODEL_PLAN_CLEANUP",
            "Pending checkout sessions could not be closed. Retry deletion.",
          )
        await verify()
        await modelPlanStripe(`checkout/sessions/${encodeURIComponent(session.id)}/expire`, { method: "POST" }, fetcher)
      }
      for (const subscription of await subscriptions(account.customer, fetcher)) {
        if (["canceled", "incomplete_expired"].includes(String(subscription.status))) continue
        await verify()
        await modelPlanStripe(
          `subscriptions/${encodeURIComponent(String(subscription.id))}`,
          { method: "DELETE" },
          fetcher,
        )
      }
    },
    fetcher,
  )
}
