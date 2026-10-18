import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import type { AccountUser } from "./account.js"
import { withBillingMutation } from "./billing-lock.js"
import { requireCodiumSales, reserveCodiumSale } from "./codium-funding.js"
import { modelPlanOrigin, modelPlans, modelTopups, MODEL_PLAN_ROOT } from "./model-plan-config.js"
import { modelPlanStripe, stripeRecord } from "./model-plan-stripe.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

// `reservation` names the checkout's hold on Vector's OpenRouter balance (see reserveCodiumSale).
const Checkout = Schema.Struct({
  id: Schema.String,
  plan: Schema.String,
  url: Schema.String,
  expires: Schema.Number,
  reservation: Schema.optional(Schema.String),
})
const Account = Schema.Struct({
  customer: Schema.String,
  closing: Schema.optional(Schema.Boolean),
  checkout: Schema.optional(Checkout),
  topupCheckout: Schema.optional(Checkout),
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

// The webhook and model requests wait this long for the account's lease before answering BILLING_MUTATION_BUSY.
const LEASE_WAIT_MS = 5_000

/**
 * The account's billing lease for the payment webhook and model requests, which wait briefly for it instead of failing
 * at once: Stripe sends several notifications for one payment at the same moment, and a buyer's first request often
 * arrives while one of them is still granting the credits. Checkout and account deletion still refuse at once.
 */
export async function withCodiumLease<T>(
  id: string,
  work: (verify: () => Promise<void>) => Promise<T>,
  fetcher: typeof fetch = fetch,
  deadline = Date.now() + LEASE_WAIT_MS,
): Promise<T> {
  return withBillingMutation(`model-plan:${id}`, work, fetcher).catch(async (error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== "BILLING_MUTATION_BUSY" || Date.now() >= deadline) throw error
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150))
    return withCodiumLease(id, work, fetcher, deadline)
  })
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
  return withCodiumLease(
    id,
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
      if (credits <= usage || credits - usage < requiredCredits) throw purchasedShortfall()
      return {
        key: revealModelPlanKey(existing.wallet.encrypted, `${id}:wallet`),
        pool: existing.wallet.hash,
        available: credits - usage,
      }
    }
  }
  return withCodiumLease(
    id,
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
        if (credits <= usage || credits - usage < requiredCredits) throw purchasedShortfall()
        return {
          key: revealModelPlanKey(account.wallet.encrypted, `${id}:wallet`),
          pool: account.wallet.hash,
          available: credits - usage,
        }
      }
      if (credits <= 0 || credits < requiredCredits) throw purchasedShortfall()
      return { ...(await provisionWalletKey(id, account, credits, fetcher, verify)), available: credits }
    },
    fetcher,
  )
}

async function provisionWalletKey(
  id: string,
  account: Account,
  credits: number,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
) {
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
  return { key: result.key, pool: result.data.hash }
}

/**
 * Bring the account's OpenRouter keys in line with what Stripe says is paid, as soon as a billing notification
 * arrives, so a buyer's credits are ready before their first request: the paid period's key gets the plan's credits
 * (each period gets a new key, so monthly credits reset rather than roll over), the purchased-credit key gets every
 * top-up still paid for, and a key nothing pays for any more is switched off. It reads Stripe's current state rather
 * than applying the notification, so a replayed or out-of-order notification changes nothing.
 */
export async function reconcileModelPlanAccount(id: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  await settlePendingTopup(id, fetcher)
  await withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) return
      const paid = account.closing
        ? []
        : (await subscriptions(account.customer, fetcher))
            .map((subscription) => paidModelPlan(subscription, id, now))
            .filter((value) => value !== undefined)
      if (account.key && paid.length !== 1) {
        await verify()
        await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
      }
      const current =
        paid.length === 1 ? (await provisionMonthlyKey(id, account, paid[0]!, fetcher, verify)).account : account
      if (current.wallet) return synchronizeWalletKey(id, current, fetcher, verify)
      if (current.closing) return
      const credits = await purchasedCredits(current, id, fetcher)
      if (credits > 0) await provisionWalletKey(id, current, credits, fetcher, verify)
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

/**
 * The key that pays for one request, with the request's largest possible cost held against its pool until release.
 * A key's usage only grows when a request finishes, so without the hold parallel requests would each pass the same
 * stale balance and spend past it, at Vector's cost.
 */
export async function modelPlanCredential(
  id: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
  requiredCredits = 0,
) {
  // Only choose a funding pool before starting inference. A provider error may
  // already represent billable work and must never trigger a second request.
  try {
    return await holdCredits(
      await monthlyCredential(id, fetcher, now, requiredCredits),
      requiredCredits,
      now,
      fetcher,
      monthlyShortfall(),
    )
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      !["MODEL_PLAN_REQUIRED", "MODEL_PLAN_PAYMENT_REQUIRED", "MODEL_PLAN_EXHAUSTED"].includes(error.code)
    )
      throw error
    const account = await readModelPlanAccount(id, fetcher)
    if (!account?.topupCheckout && !account?.purchases?.length) throw error
    return holdCredits(
      await walletCredential(id, fetcher, requiredCredits),
      requiredCredits,
      now,
      fetcher,
      purchasedShortfall(),
    )
  }
}

// Credits that are used up, too few for the model's largest request, or held by requests still running get one
// answer per pool. A different answer for each would tell a client which side of a threshold its balance is on, and
// with the share of a plan it has used, the allowance and so the markup.
function monthlyShortfall() {
  return new ApiError(
    402,
    "MODEL_PLAN_EXHAUSTED",
    "Your monthly Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, choose a model that uses fewer credits, or add a top-up. Monthly credits renew each billing period.",
  )
}

function purchasedShortfall() {
  return new ApiError(
    402,
    "MODEL_TOPUP_EXHAUSTED",
    "Your purchased Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, choose a model that uses fewer credits, or add credits.",
  )
}

// Each hold is one member of the pool's sorted set, "<ticket>:<credits>", scored by when it lapses, so a hold whose
// request never settles (an answer that broke off or was cancelled, or a function killed at its time limit) frees
// itself once the request could no longer run.
const HOLD =
  "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) local held = 0 for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do held = held + (tonumber(string.match(member, ':([^:]+)$')) or 0) end if tonumber(ARGV[2]) - held < tonumber(ARGV[3]) then return 0 end redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5]) redis.call('PEXPIRE', KEYS[1], ARGV[6]) return 1"
const SETTLE = "redis.call('ZREM', KEYS[1], ARGV[1]) redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]) return 1"
// The gateway gives a provider request 600 seconds.
const HOLD_MS = 660_000
// The provider adds a finished request to the key's usage; its charge stays held a little longer so a request sent
// meanwhile cannot spend it a second time.
const SETTLED_MS = 30_000

async function holdCredits(
  funding: { key: string; pool: string; available: number },
  requiredCredits: number,
  now: number,
  fetcher: typeof fetch,
  refusal: ApiError,
) {
  // Provisioning and checks without a request to pay for hold nothing.
  if (requiredCredits <= 0) return { key: funding.key, release: async (_charge?: number) => {} }
  const pool = `vector:model-plans:held:${funding.pool}`
  const ticket = randomUUID()
  const member = `${ticket}:${requiredCredits}`
  const held = await persistentStore(
    ["EVAL", HOLD, 1, pool, now, funding.available, requiredCredits, now + HOLD_MS, member, HOLD_MS],
    fetcher,
  )
  if (held !== 1) throw refusal
  return {
    key: funding.key,
    /** Pass what the request was charged once it reached the provider, or nothing when it never did. */
    release: async (charge?: number) => {
      if (charge === undefined) {
        await persistentStore(["ZREM", pool, member], fetcher)
        return
      }
      await persistentStore(["EVAL", SETTLE, 1, pool, member, Date.now() + SETTLED_MS, `${ticket}:${charge}`], fetcher)
    },
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
  const paid = eligible.length === 1 ? eligible[0] : undefined
  if (!paid) return { active: false as const, customer: true }
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
        requireMonthlyCredits(paid.plan.credits, key.usage, requiredCredits)
        return {
          key: revealModelPlanKey(existing.key.encrypted, `${id}:${paid.id}:${paid.start}`),
          pool: existing.key.hash,
          available: paid.plan.credits - key.usage,
        }
      }
    }
  }
  return withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account)
        throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Codium subscription or add credits to use this model.")
      if (account.closing)
        throw new ApiError(409, "MODEL_PLAN_ACCOUNT_CLOSING", "This account is being deleted. Model access is closed.")
      const eligible = (await subscriptions(account.customer, fetcher))
        .map((subscription) => paidModelPlan(subscription, id, now))
        .filter((value) => value !== undefined)
      const paid = eligible.length === 1 ? eligible[0] : undefined
      if (!paid) {
        if (account.key)
          await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
        throw new ApiError(
          402,
          "MODEL_PLAN_PAYMENT_REQUIRED",
          "Your model subscription needs an active paid billing period.",
        )
      }
      if (paid.plan.credits < requiredCredits) throw monthlyShortfall()
      const funding = await provisionMonthlyKey(id, account, paid, fetcher, verify)
      requireMonthlyCredits(paid.plan.credits, funding.usage, requiredCredits)
      return { key: funding.key, pool: funding.pool, available: paid.plan.credits - funding.usage }
    },
    fetcher,
  )
}

/** The paid period's key, repaired to the plan's credits, or a new one when the period changed. Callers hold the lease. */
async function provisionMonthlyKey(
  id: string,
  account: Account,
  paid: NonNullable<ReturnType<typeof paidModelPlan>>,
  fetcher: typeof fetch,
  verify: () => Promise<void>,
) {
  const context = `${id}:${paid.id}:${paid.start}`
  const expires = new Date(paid.end * 1000).toISOString()
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
    if (
      key.disabled ||
      key.limit !== paid.plan.credits ||
      key.limit_reset !== null ||
      key.include_byok_in_limit !== true ||
      key.expires_at !== expires
    ) {
      await verify()
      await openRouterManagement(
        `/${encodeURIComponent(account.key.hash)}`,
        {
          disabled: false,
          limit: paid.plan.credits,
          limit_reset: null,
          include_byok_in_limit: true,
          expires_at: expires,
        },
        fetcher,
        "PATCH",
      )
    }
    return {
      key: revealModelPlanKey(account.key.encrypted, context),
      pool: account.key.hash,
      usage: key.usage,
      account,
    }
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
      expires_at: expires,
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
  const updated = {
    ...account,
    key: {
      hash: result.data.hash,
      encrypted: protectModelPlanKey(result.key, context),
      subscription: paid.id,
      start: paid.start,
      end: paid.end,
      credits: paid.plan.credits,
    },
  }
  await saveAccount(id, updated, fetcher)
  return { key: result.key, pool: result.data.hash, usage: 0, account: updated }
}

// A shortfall keeps the code that lets purchased credits cover the request instead.
function requireMonthlyCredits(credits: number, usage: number, requiredCredits: number) {
  if (usage >= credits || credits - usage < requiredCredits) throw monthlyShortfall()
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
  const priceID = plan.priceID
  // Sell only credits Vector's OpenRouter balance can pay for.
  const funding = await requireCodiumSales(fetcher, now)
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
      const earlier = account.checkout && account.checkout.expires > now ? account.checkout : undefined
      const pending = earlier
        ? await modelPlanStripe(`checkout/sessions/${encodeURIComponent(earlier.id)}`, {}, fetcher)
        : undefined
      if (pending?.status === "complete")
        throw new ApiError(
          409,
          "MODEL_PLAN_EXISTS",
          "Checkout has already completed. Refresh your account or manage your subscription.",
        )
      if (
        earlier &&
        pending?.status === "open" &&
        earlier.plan === plan.id &&
        stripeRecord(pending.metadata) &&
        pending.metadata.vector_model_credits_usd === String(plan.credits) &&
        pending.metadata.vector_price_id === priceID
      )
        return { url: earlier.url }
      if (pending?.status === "open") await verify()
      const closed =
        earlier && pending?.status === "open"
          ? await modelPlanStripe(
              `checkout/sessions/${encodeURIComponent(earlier.id)}/expire`,
              { method: "POST" },
              fetcher,
            )
          : pending
      const price = await modelPlanStripe(`prices/${priceID}`, {}, fetcher)
      const recurring = stripeRecord(price.recurring) ? price.recurring : undefined
      if (
        price.active !== true ||
        price.currency !== "usd" ||
        price.unit_amount !== plan.price * 100 ||
        recurring?.interval !== "month" ||
        recurring.interval_count !== 1
      )
        throw new ApiError(503, "MODEL_PLAN_PRICE_MISMATCH", "This subscription price is not configured correctly.")
      const closes = (Math.floor(now / 1_800_000) + 2) * 1_800_000
      const idempotency = `vector-model-checkout-${user.id}-${plan.id}-${createHash("sha256").update(`${priceID}:${plan.credits}`).digest("hex").slice(0, 12)}-${account.checkout?.id ?? "new"}-${Math.floor(now / 1_800_000)}`
      // Only a checkout that can no longer be paid gives its reservation back. A paid one keeps counting until it
      // lapses, because the reading this sale is measured against may not count its credits as owed yet.
      await reserveCodiumSale(
        funding,
        {
          id: idempotency,
          credits: plan.credits,
          closes,
          released: closed?.status === "expired" ? earlier?.reservation : undefined,
        },
        fetcher,
        now,
      )
      await verify()
      const checkout = await modelPlanStripe(
        "checkout/sessions",
        {
          method: "POST",
          idempotency,
          body: new URLSearchParams({
            mode: "subscription",
            "payment_method_types[0]": "card",
            customer,
            client_reference_id: user.id,
            "line_items[0][price]": priceID,
            "line_items[0][quantity]": "1",
            "metadata[vector_model_credits_usd]": String(plan.credits),
            "metadata[vector_price_id]": priceID,
            "subscription_data[metadata][vector_account_id]": user.id,
            "subscription_data[metadata][vector_plan]": plan.id,
            "subscription_data[metadata][vector_model_credits_usd]": String(plan.credits),
            success_url: `${modelPlanOrigin()}/account?model_plan=success`,
            cancel_url: `${modelPlanOrigin()}/account?model_plan=cancelled`,
            expires_at: String(closes / 1000),
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
          checkout: {
            id: checkout.id,
            plan: plan.id,
            url: checkout.url,
            expires: checkout.expires_at * 1000,
            reservation: idempotency,
          },
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
  const priceID = pack.priceID
  const funding = await requireCodiumSales(fetcher, now)
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
      const earlier = account.topupCheckout && account.topupCheckout.expires > now ? account.topupCheckout : undefined
      const pending = earlier
        ? await modelPlanStripe(`checkout/sessions/${encodeURIComponent(earlier.id)}`, {}, fetcher)
        : undefined
      if (
        earlier &&
        pending?.status === "complete" &&
        !account.purchases?.some((value) => value.checkout === earlier.id)
      )
        throw new ApiError(
          409,
          "MODEL_TOPUP_PROCESSING",
          "Your last credit purchase is processing. Refresh your account and retry.",
        )
      if (
        earlier &&
        pending?.status === "open" &&
        earlier.plan === pack.id &&
        stripeRecord(pending.metadata) &&
        pending.metadata.vector_credits_usd === String(pack.credits) &&
        pending.metadata.vector_price_id === priceID
      )
        return { url: earlier.url }
      if (pending?.status === "open") await verify()
      const closed =
        earlier && pending?.status === "open"
          ? await modelPlanStripe(
              `checkout/sessions/${encodeURIComponent(earlier.id)}/expire`,
              { method: "POST" },
              fetcher,
            )
          : pending
      const price = await modelPlanStripe(`prices/${priceID}`, {}, fetcher)
      if (
        price.active !== true ||
        price.currency !== "usd" ||
        price.unit_amount !== pack.price * 100 ||
        price.recurring
      )
        throw new ApiError(503, "MODEL_TOPUP_PRICE_MISMATCH", "This credit-pack price is not configured correctly.")
      const closes = (Math.floor(now / 1_800_000) + 2) * 1_800_000
      const body = new URLSearchParams({
        mode: "payment",
        "payment_method_types[0]": "card",
        customer,
        client_reference_id: user.id,
        "line_items[0][price]": priceID,
        "line_items[0][quantity]": "1",
        success_url: `${modelPlanOrigin()}/account?model_topup=success`,
        cancel_url: `${modelPlanOrigin()}/account?model_topup=cancelled`,
        expires_at: String(closes / 1000),
      })
      Object.entries({
        vector_account_id: user.id,
        vector_product: "codium-topup",
        vector_pack: pack.id,
        vector_credits_usd: String(pack.credits),
        vector_price_id: priceID,
      }).forEach(([key, value]) => {
        body.set(`metadata[${key}]`, value)
        body.set(`payment_intent_data[metadata][${key}]`, value)
      })
      const idempotency = `vector-topup-checkout-${user.id}-${pack.id}-${createHash("sha256").update(`${priceID}:${pack.credits}`).digest("hex").slice(0, 12)}-${account.topupCheckout?.id ?? "new"}-${Math.floor(now / 1_800_000)}`
      // A paid top-up keeps its reservation when the buyer opens the next one: the reading this sale is measured
      // against may not count its credits as owed yet. Only a checkout that can no longer be paid gives it back.
      await reserveCodiumSale(
        funding,
        {
          id: idempotency,
          credits: pack.credits,
          closes,
          released: closed?.status === "expired" ? earlier?.reservation : undefined,
        },
        fetcher,
        now,
      )
      await verify()
      const checkout = await modelPlanStripe(
        "checkout/sessions",
        {
          method: "POST",
          idempotency,
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
          topupCheckout: {
            id: checkout.id,
            plan: pack.id,
            url: checkout.url,
            expires: checkout.expires_at * 1000,
            reservation: idempotency,
          },
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
