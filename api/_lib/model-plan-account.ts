import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { Option, Schema } from "effect"
import type { AccountUser } from "./account.js"
import { withBillingMutation } from "./billing-lock.js"
import { requireCodiumSales, reserveCodiumSale } from "./codium-funding.js"
import { codiumKey, openRouterKeyName } from "./codium-keys.js"
import { codiumKeyLimitUsd } from "./codium-limits.js"
import {
  DEBIT_RETRY_MS,
  DEBITS_KEEP_MS,
  dueDebitApplies,
  EMPTY_LEDGER,
  expectedLimitMicro,
  finishDebitApply,
  isPoolPurpose,
  limitMatches,
  limitUsd,
  markDebitsApplied,
  MAX_POOL_HOLD_MS,
  microToUsd,
  MODEL_HOLD_MS,
  placeHold,
  poolFigures,
  poolShareUsed,
  postponeDebitApply,
  readDebits,
  readPoolLedger,
  recordDebit,
  releaseHold,
  settleHold,
  usdToMicro,
  usdToMicroCeil,
  validDebitRef,
  validRunId,
  type PoolBase,
  type PoolPurpose,
  type PoolTicket,
} from "./codium-pool.js"
import {
  modelPlanOrigin,
  modelPlans,
  modelPlansEnabled,
  MODEL_PLAN_ROOT,
  requireCodiumCheckoutUser,
  subscriptionPlanCredits,
} from "./model-plan-config.js"
import { modelPlanStripe, stripeMode, stripeRecord } from "./model-plan-stripe.js"
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
const Micro = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
// Codium sells monthly plans only (WP A04). A record written while top-ups existed may still carry `topupCheckout`,
// `purchases` and `wallet`, in any shape: decoding ignores keys the struct does not name, so such a record still
// decodes, nothing reads those fields, and the next save leaves them out. Sales never opened, so no one holds
// purchased credits that would need honouring.
const Account = Schema.Struct({
  customer: Schema.String,
  closing: Schema.optional(Schema.Boolean),
  checkout: Schema.optional(Checkout),
  key: Schema.optional(
    Schema.Struct({
      hash: Schema.String,
      encrypted: Schema.String,
      subscription: Schema.String,
      start: Schema.Number,
      end: Schema.Number,
      credits: Schema.Number,
      // The pool in integer micro-dollars (codium-pool.ts): the credits this key grants (test-mode cap applied), the
      // carry an upgrade brought (WP A09), and the limit last set on the key, credits + carry − applied debits. A
      // record written before these existed has no debits, so its limit is its credits.
      creditsMicro: Schema.optional(Micro),
      carry: Schema.optional(
        Schema.Struct({
          micro: Micro,
          fromSubscription: Schema.String,
          fromStart: Schema.Number,
          fromCharge: Schema.String,
        }),
      ),
      limitMicro: Schema.optional(Micro),
    }),
  ),
})
type Account = typeof Account.Type
type AccountKey = NonNullable<Account["key"]>
const accountKey = (id: string) => codiumKey("account", id)

/** The pool one key pays from: its credits and carry, and the limit the key should have now. */
function keyPool(key: AccountKey): PoolBase & { limitMicro: number } {
  const creditsMicro = key.creditsMicro ?? usdToMicro(codiumKeyLimitUsd(key.credits))
  const carryMicro = key.carry?.micro ?? 0
  return { creditsMicro, carryMicro, limitMicro: key.limitMicro ?? creditsMicro + carryMicro }
}

/**
 * The account's billing lease. Checkout, deletion, the webhook and model requests all serialize on this one key, in the
 * same mode namespace as the account it guards.
 */
function withAccountLease<T>(id: string, work: (verify: () => Promise<void>) => Promise<T>, fetcher: typeof fetch) {
  return withBillingMutation(`model-plan:${id}`, work, fetcher, { key: codiumKey("lease", id) })
}

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

/**
 * A call to OpenRouter's key management API. Creating a key (POST) names an idempotency key, so a create retried after a
 * lost answer can be recognised instead of leaving a second funded key behind; the account lease is what serializes
 * the creates themselves.
 */
export async function openRouterManagement(
  path: string,
  body?: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  method = "GET",
  idempotency?: string,
) {
  if (method === "POST" && !idempotency?.trim())
    throw new ApiError(500, "MODEL_PLAN_IDEMPOTENCY_REQUIRED", "Your model allowance could not be created.")
  const response = await fetcher(`${MODEL_PLAN_ROOT}/keys${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY ?? ""}`,
      "content-type": "application/json",
      ...(idempotency ? { "Idempotency-Key": idempotency } : {}),
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
  return withAccountLease(id, work, fetcher).catch(async (error: unknown) => {
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

/**
 * Whether a disputed charge may still pay for its month. `Charge.disputed` is historical, so a resolved dispute can
 * leave it true: only conclusively merchant-won or closed-inquiry disputes on this charge restore it. Unknown,
 * pending, lost, truncated and mismatched results all leave it unavailable.
 */
async function chargeAvailable(charge: Record<string, unknown>, chargeID: string, fetcher: typeof fetch) {
  if (charge.disputed === false) return true
  if (charge.disputed !== true || !chargeID) return false
  const query = new URLSearchParams({ charge: chargeID, limit: "100" })
  const result = await modelPlanStripe(`disputes?${query}`, {}, fetcher)
  return (
    result.has_more === false &&
    Array.isArray(result.data) &&
    result.data.length > 0 &&
    result.data.every(
      (value) =>
        stripeRecord(value) && ["won", "warning_closed"].includes(String(value.status)) && value.charge === chargeID,
    )
  )
}

/**
 * Bring the account's OpenRouter key in line with what Stripe says is paid, as soon as a billing notification
 * arrives, so a buyer's credits are ready before their first request: the paid period's key gets the plan's credits
 * (each period gets a new key, so monthly credits reset rather than roll over), and a key nothing pays for any more
 * is switched off. It reads Stripe's current state rather than applying the notification, so a replayed or
 * out-of-order notification changes nothing.
 */
export async function reconcileModelPlanAccount(id: string, fetcher: typeof fetch = fetch, now = Date.now()) {
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
      if (paid.length === 1) await provisionMonthlyKey(id, account, paid[0]!, fetcher, verify)
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
  const credits = subscriptionPlanCredits(metadata, configured)
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
        !(await chargeAvailable(charge, charge.id, fetcher))
      )
        return subscription
      return { ...subscription, latest_invoice: { ...invoice, charge: { ...charge, disputed: false } } }
    }),
  )
}

/**
 * The account's Codium month for its own screens. There are no top-ups, so access is the paid month alone; the status
 * route still answers `purchased: {bought: false}` for clients up to 1.99.112 (model-plan-status.ts).
 */
export async function modelPlanStatus(id: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  const account = await readModelPlanAccount(id, fetcher)
  const monthly = await monthlyStatus(id, fetcher, now)
  if (!account || account.closing) return { ...monthly, access: false }
  return { ...monthly, customer: true, access: monthly.active }
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
  options: { purpose?: PoolPurpose; runId?: string } = {},
) {
  // A request's largest cost, in whole micro-dollars and never rounded down.
  const required = requiredCredits > 0 ? usdToMicroCeil(requiredCredits) : 0
  return holdCredits(
    id,
    await monthlyCredential(id, fetcher, now, required),
    required,
    now,
    fetcher,
    monthlyShortfall(),
    { purpose: options.purpose ?? "chat", run: options.runId },
  )
}

// Credits that are used up, too few for the model's largest request, or held by requests still running get one
// answer per pool. A different answer for each would tell a client which side of a threshold its balance is on, and
// with the share of a plan it has used, the allowance and so the markup. Codium sells monthly plans only, so the
// answer offers nothing to buy.
function monthlyShortfall() {
  return new ApiError(
    402,
    "MODEL_PLAN_EXHAUSTED",
    "Your monthly Codium credits cannot cover this model's largest request right now. Wait for running requests to finish, or choose a model that uses fewer credits. Monthly credits renew each billing period.",
  )
}

/**
 * Holds a request's largest cost against its pool (codium-pool.ts HOLD): one member of the pool's held set,
 * `<ticket>:<purpose>:<runId or ->:<micro>`, scored by when it lapses, so a hold whose request never settles (an answer
 * that broke off or was cancelled, or a function killed at its time limit) frees itself once the request could no
 * longer run. The script takes the applied debits and every live hold off the pool's base in the same step.
 */
async function holdCredits(
  id: string,
  funding: { key: string; pool: string; baseMicro: number },
  requiredMicro: number,
  now: number,
  fetcher: typeof fetch,
  refusal: ApiError,
  hold: { purpose: PoolPurpose; run?: string },
) {
  // Provisioning and checks without a request to pay for hold nothing.
  if (requiredMicro <= 0) return { key: funding.key, release: async (_charge?: number) => {} }
  const ticket = await placeHold(
    {
      account: id,
      pool: funding.pool,
      baseMicro: funding.baseMicro,
      requiredMicro,
      purpose: hold.purpose,
      run: hold.run,
      ttlMs: MODEL_HOLD_MS,
      now,
    },
    fetcher,
  )
  if (!ticket) throw refusal
  return {
    key: funding.key,
    /** Pass what the request was charged once it reached the provider, in dollars, or nothing when it never did. */
    release: async (charge?: number) => {
      if (charge === undefined) return releaseHold(ticket, fetcher)
      await settleHold(
        ticket,
        Number.isFinite(charge) ? usdToMicroCeil(Math.max(0, charge)) : ticket.micro,
        Date.now(),
        fetcher,
      )
    },
  }
}

/**
 * The paid month as the account's screens show it, in dollars that never leave the server: `credits` is the pool's
 * total (credits + carry), `used` what was spent (usage + debits), `remaining` what is left of the month, `available`
 * what a new request could still hold (M3), and `shareUsed` the whole-percent share spent.
 */
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
      ? usdToMicro(data.usage)
      : current
        ? undefined
        : 0
  // In test mode the key holds less than the plan's credits; the share left is of what the key can spend.
  const pool = current
    ? keyPool(current)
    : { creditsMicro: usdToMicro(codiumKeyLimitUsd(paid.plan.credits)), carryMicro: 0 }
  const ledger = current ? await readPoolLedger(id, current.hash, now, fetcher) : EMPTY_LEDGER
  const figures = poolFigures(pool, usage ?? 0, ledger)
  const known = <T>(value: T) => (usage === undefined ? undefined : value)
  return {
    active: true as const,
    plan: paid.plan.id,
    credits: microToUsd(figures.totalMicro),
    used: known(microToUsd(figures.spentMicro)),
    remaining: known(microToUsd(Math.max(0, figures.remainingMicro))),
    available: known(microToUsd(Math.max(0, figures.availableMicro))),
    shareUsed: known(poolShareUsed(figures)),
    periodStart: paid.start * 1000,
    periodEnd: paid.end * 1000,
    cancelAtPeriodEnd: paid.cancelAtPeriodEnd,
  }
}

/**
 * The key that pays for a month's request and what its pool holds: `baseMicro` is credits + carry − usage, from which
 * the hold takes the applied debits and the live holds. Normal parallel requests only read the account and the key;
 * provisioning, repairs and debits are serialized on the account's lease.
 */
async function monthlyCredential(id: string, fetcher: typeof fetch, now: number, requiredMicro: number) {
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
      const pool = keyPool(existing.key)
      // The key's limit must be the one the pool last set (M1), within half a cent; anything else is repaired under the
      // lease below, where the debits are read.
      if (
        stripeRecord(key) &&
        key.disabled === false &&
        limitMatches(key.limit, pool.limitMicro) &&
        key.limit_reset === null &&
        key.include_byok_in_limit === true &&
        key.expires_at === new Date(paid.end * 1000).toISOString() &&
        typeof key.usage === "number" &&
        Number.isFinite(key.usage) &&
        key.usage >= 0
      ) {
        const usage = usdToMicro(key.usage)
        requireMonthlyCredits(pool.limitMicro - usage, requiredMicro)
        return {
          key: revealModelPlanKey(existing.key.encrypted, `${id}:${paid.id}:${paid.start}`),
          pool: existing.key.hash,
          baseMicro: pool.creditsMicro + pool.carryMicro - usage,
          end: paid.end,
        }
      }
    }
  }
  return withCodiumLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) throw new ApiError(402, "MODEL_PLAN_REQUIRED", "Choose a Codium plan to use this model.")
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
      // A request no month of this plan could ever pay for creates no key.
      const current =
        account.key?.subscription === paid.id && account.key.start === paid.start ? account.key : undefined
      const most = current
        ? keyPool(current)
        : { creditsMicro: usdToMicro(codiumKeyLimitUsd(paid.plan.credits)), carryMicro: 0 }
      if (most.creditsMicro + most.carryMicro < requiredMicro) throw monthlyShortfall()
      const funding = await provisionMonthlyKey(id, account, paid, fetcher, verify)
      requireMonthlyCredits(funding.limitMicro - funding.usageMicro, requiredMicro)
      return {
        key: funding.key,
        pool: funding.pool,
        baseMicro: funding.creditsMicro + funding.carryMicro - funding.usageMicro,
        end: paid.end,
      }
    },
    fetcher,
  )
}

/**
 * The paid period's key, or a new one when the period changed. Callers hold the lease. An existing key is brought to
 * what the pool says (M1): enabled, expiring at the period's end, and limited to credits + carry less every debit
 * recorded against it, never back to the plan's credits. Its limit is PATCHed only when it is more than half a cent
 * off, and any debit not yet applied is applied in the same pass.
 */
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
    const converged = await convergeKey(id, account, account.key, verify, fetcher, { expiresAt: expires })
    return {
      key: revealModelPlanKey(account.key.encrypted, context),
      pool: account.key.hash,
      usageMicro: converged.usageMicro,
      account: converged.account,
      creditsMicro: converged.creditsMicro,
      carryMicro: converged.carryMicro,
      limitMicro: converged.limitMicro,
    }
  }
  if (account.key)
    await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
  await verify()
  // A new period starts at the plan's credits; in test mode the key holds no more than the test cap.
  const creditsMicro = usdToMicro(codiumKeyLimitUsd(paid.plan.credits))
  const result = await openRouterManagement(
    "",
    {
      name: openRouterKeyName([id, paid.id, paid.start]),
      limit: limitUsd(creditsMicro),
      limit_reset: null,
      include_byok_in_limit: true,
      expires_at: expires,
    },
    fetcher,
    "POST",
    `vector-codium-key-${stripeMode()}-${digest(context)}`,
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
      creditsMicro,
      limitMicro: creditsMicro,
    },
  }
  await saveAccount(id, updated, fetcher)
  return {
    key: result.key,
    pool: result.data.hash,
    usageMicro: 0,
    account: updated,
    creditsMicro,
    carryMicro: 0,
    limitMicro: creditsMicro,
  }
}

/**
 * Sets the account's current key to its pool's limit, credits + carry less every debit recorded against it, and marks
 * the debits that limit includes applied, saving the limit in the account record in the same step. Callers hold the
 * lease. `repair` also re-enables the key and resets its other settings; only provisioning for a paid period passes it,
 * so applying a debit never turns a key back on.
 */
async function convergeKey(
  id: string,
  account: Account,
  key: AccountKey,
  verify: () => Promise<void>,
  fetcher: typeof fetch,
  repair?: { expiresAt: string },
) {
  const debits = await readDebits(id, key.hash, fetcher)
  const pending = debits.filter((debit) => !debit.applied)
  const pool = keyPool(key)
  const limitMicro = expectedLimitMicro(
    pool,
    debits.reduce((sum, debit) => sum + debit.micro, 0),
  )
  const data = (await openRouterManagement(`/${encodeURIComponent(key.hash)}`, undefined, fetcher)).data
  if (
    !stripeRecord(data) ||
    typeof data.disabled !== "boolean" ||
    (repair && (typeof data.usage !== "number" || !Number.isFinite(data.usage) || data.usage < 0))
  )
    throw new ApiError(503, "MODEL_PLAN_KEY_INVALID", "Your model allowance could not be verified.")
  const settings =
    repair &&
    (data.disabled ||
      data.limit_reset !== null ||
      data.include_byok_in_limit !== true ||
      data.expires_at !== repair.expiresAt)
  if (settings || !limitMatches(data.limit, limitMicro)) {
    await verify()
    await openRouterManagement(
      `/${encodeURIComponent(key.hash)}`,
      repair
        ? {
            disabled: false,
            limit: limitUsd(limitMicro),
            limit_reset: null,
            include_byok_in_limit: true,
            expires_at: repair.expiresAt,
          }
        : { limit: limitUsd(limitMicro) },
      fetcher,
      "PATCH",
    )
  }
  const changed = key.limitMicro !== limitMicro || key.creditsMicro !== pool.creditsMicro
  const updated = changed ? { ...account, key: { ...key, creditsMicro: pool.creditsMicro, limitMicro } } : account
  const left =
    pending.length || changed
      ? await verify().then(() =>
          markDebitsApplied(
            {
              account: id,
              keyHash: key.hash,
              accountRecord: changed ? { key: accountKey(id), json: JSON.stringify(updated) } : undefined,
              pending,
            },
            fetcher,
          ),
        )
      : 0
  return {
    account: updated,
    usageMicro: typeof data.usage === "number" && Number.isFinite(data.usage) ? usdToMicro(Math.max(0, data.usage)) : 0,
    creditsMicro: pool.creditsMicro,
    carryMicro: pool.carryMicro,
    limitMicro,
    applied: pending.length,
    pending: left,
  }
}

// `available` is the pool's credits and carry less its applied debits and usage; the hold itself then takes the live
// holds off as well (M3).
function requireMonthlyCredits(availableMicro: number, requiredMicro: number) {
  if (availableMicro <= 0 || availableMicro < requiredMicro) throw monthlyShortfall()
}

/** A hold on an account's pool for a charge made outside OpenRouter: a hosted block, or any other pool charge. */
export type PoolHold = {
  ticket: string
  micro: number
  expiresAt: number
  /**
   * Records what the charge cost, in dollars, as a debit under `ref` (a retry with the same ref records nothing new),
   * then lowers the key's limit by it. The charge stays held until that is done; when the key cannot be updated now,
   * the outbox action `debit-apply` retries it. `applied` says whether the limit already carries it.
   */
  settle(chargedUsd: number, ref: string): Promise<{ recorded: boolean; applied: boolean }>
  /** Gives the hold back unspent, when nothing was charged. */
  release(): Promise<void>
}

/**
 * Holds `usd` of an account's pool for `ttlMs` for a charge made outside OpenRouter (§4.7 `holdPool`): the same held
 * set and the same available figure as model requests (M2, M3), so a hosted block can never spend what a request is
 * holding, nor the other way round. Refused with the same answer as any other shortfall.
 */
export async function holdPool(
  account: string,
  usd: number,
  ttlMs: number,
  purpose: PoolPurpose,
  options: { runId?: string; fetcher?: typeof fetch; now?: number } = {},
): Promise<PoolHold> {
  if (
    !Number.isFinite(usd) ||
    usd <= 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1_000 ||
    ttlMs > MAX_POOL_HOLD_MS ||
    !isPoolPurpose(purpose) ||
    !validRunId(options.runId)
  )
    throw new ApiError(500, "MODEL_PLAN_POOL_INVALID", "This Codium charge could not be held.")
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const required = usdToMicroCeil(usd)
  const funding = await monthlyCredential(account, fetcher, now, required)
  const ticket = await placeHold(
    {
      account,
      pool: funding.pool,
      baseMicro: funding.baseMicro,
      requiredMicro: required,
      purpose,
      run: options.runId,
      ttlMs,
      now,
    },
    fetcher,
  )
  if (!ticket) throw monthlyShortfall()
  return {
    ticket: ticket.ticket,
    micro: ticket.micro,
    expiresAt: now + ttlMs,
    release: () => releaseHold(ticket, fetcher),
    settle: (chargedUsd, ref) => settlePoolCharge(ticket, funding.end, chargedUsd, ref, fetcher),
  }
}

async function settlePoolCharge(
  ticket: PoolTicket,
  periodEnd: number,
  chargedUsd: number,
  ref: string,
  fetcher: typeof fetch,
) {
  if (!Number.isFinite(chargedUsd) || chargedUsd < 0 || !validDebitRef(ref))
    throw new ApiError(500, "MODEL_PLAN_POOL_INVALID", "This Codium charge could not be recorded.")
  // A charge is never rounded down: what the pool pays covers at least what the provider charged.
  const micro = usdToMicroCeil(chargedUsd)
  const now = Date.now()
  const recorded = await recordDebit(ticket, { ref, micro, keepUntil: periodEnd * 1000 + DEBITS_KEEP_MS, now }, fetcher)
  // The debit is held until applied, and queued for `debit-apply`, so a key that cannot be updated now loses nothing.
  const applied = await applyPoolDebits(ticket.account, ticket.pool, fetcher).then(
    () => true,
    () => false,
  )
  return { recorded, applied }
}

/**
 * The outbox action `debit-apply` (contract §4.8): under the account's lease, lowers the key's limit by every debit
 * recorded against it and marks them applied. A debit on a key the account no longer uses is marked applied without
 * touching that key: it was switched off when it was replaced, so its limit no longer spends anything. Returns how many
 * debits were applied and how many arrived meanwhile and are still pending.
 */
export async function applyPoolDebits(account: string, keyHash?: string, fetcher: typeof fetch = fetch) {
  return withCodiumLease(
    account,
    async (verify) => {
      const record = await readModelPlanAccount(account, fetcher)
      const hash = keyHash ?? record?.key?.hash
      if (!hash) return { applied: 0, pending: 0 }
      if (record?.key?.hash === hash) {
        const converged = await convergeKey(account, record, record.key, verify, fetcher)
        return { applied: converged.applied, pending: converged.pending }
      }
      const pending = (await readDebits(account, hash, fetcher)).filter((debit) => !debit.applied)
      await verify()
      const left = await markDebitsApplied({ account, keyHash: hash, pending }, fetcher)
      return { applied: pending.length, pending: left }
    },
    fetcher,
  )
}

/**
 * Retries every key whose `debit-apply` is due, one at a time within `budgetMs`, until the outbox (WP A06) takes this
 * action over. A key that still fails is tried again after DEBIT_RETRY_MS; its debits stay held meanwhile.
 */
export async function drainDebitApplies(
  options: { fetcher?: typeof fetch; now?: number; budgetMs?: number; limit?: number } = {},
) {
  const fetcher = options.fetcher ?? fetch
  const started = Date.now()
  const now = options.now ?? started
  const budget = options.budgetMs ?? 20_000
  const due = await dueDebitApplies(now, options.limit ?? 50, fetcher)
  const outcome = { applied: 0, retried: 0 }
  for (const item of due) {
    if (Date.now() - started >= budget) break
    const result = await applyPoolDebits(item.account, item.keyHash, fetcher).catch(() => undefined)
    if (result && result.pending === 0) {
      await finishDebitApply(item.account, item.keyHash, fetcher)
      outcome.applied++
    } else {
      await postponeDebitApply(item.account, item.keyHash, Date.now() + DEBIT_RETRY_MS, fetcher)
      outcome.retried++
    }
  }
  return outcome
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
  requireCodiumCheckoutUser(user)
  // Sell only credits Vector's OpenRouter balance can pay for.
  const funding = await requireCodiumSales(fetcher, now)
  return withAccountLease(
    user.id,
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
              { method: "POST", idempotency: `vector-expire-${earlier.id}` },
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

/**
 * A Stripe customer portal session: the portal's home, or straight to changing or cancelling the subscription. Changing
 * plans sells credits, so the portal that offers it (STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID) opens only while Codium
 * is on sale and Vector's OpenRouter balance can pay for them, as for a checkout; otherwise the portal without plan
 * changes keeps the card, invoices and cancellation reachable.
 */
export async function modelPlanPortal(
  id: string,
  fetcher: typeof fetch = fetch,
  options: { flow?: "change" | "cancel"; now?: number } = {},
) {
  const account = await readModelPlanAccount(id, fetcher)
  if (!account) throw new ApiError(404, "MODEL_PLAN_ACCOUNT_MISSING", "No Codium billing account exists yet.")
  const changes = process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID?.trim()
  const switching = Boolean(
    changes &&
      modelPlansEnabled() &&
      (await requireCodiumSales(fetcher, options.now).then(
        () => true,
        () => false,
      )),
  )
  const configuration = switching ? changes : process.env.STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID?.trim()
  if (!configuration)
    throw new ApiError(503, "BILLING_PORTAL_UNAVAILABLE", "Subscription management is temporarily unavailable.")
  if (options.flow === "change" && !switching)
    throw new ApiError(
      409,
      "MODEL_PLAN_CHANGE_UNAVAILABLE",
      "Plan changes are not available right now. Your plan stays as it is.",
    )
  const subscription = options.flow
    ? (await subscriptions(account.customer, fetcher)).flatMap((value) => {
        const paid = paidModelPlan(value, id, options.now)
        // A smaller plan chosen in the portal waits for the renewal date in a subscription schedule.
        return paid ? [{ ...paid, scheduled: stripeRecord(value) && Boolean(value.schedule) }] : []
      })
    : []
  if (options.flow && subscription.length !== 1)
    throw new ApiError(
      404,
      "MODEL_PLAN_MISSING",
      `There is no paid Codium plan to ${options.flow === "cancel" ? "cancel" : "change"}.`,
    )
  // Stripe does not change a subscription that is cancelling or already has a change waiting, so say why here rather
  // than open a portal step that fails.
  if (options.flow === "cancel" && subscription[0]!.cancelAtPeriodEnd)
    throw new ApiError(409, "MODEL_PLAN_ENDING", "Your plan already ends at the close of this billing period.")
  if (options.flow === "change" && subscription[0]!.cancelAtPeriodEnd)
    throw new ApiError(
      409,
      "MODEL_PLAN_ENDING",
      "Your plan ends at the close of this billing period, so it cannot be changed. Choose a plan again after it ends.",
    )
  if (options.flow === "change" && subscription[0]!.scheduled)
    throw new ApiError(
      409,
      "MODEL_PLAN_CHANGE_SCHEDULED",
      "Your plan already has a change waiting for its renewal date. You can change it again after that date.",
    )
  const flow = options.flow === "change" ? "subscription_update" : "subscription_cancel"
  const body = new URLSearchParams({
    customer: account.customer,
    configuration,
    return_url: `${modelPlanOrigin()}/account`,
    // A finished change or cancellation returns to the account page, which Vector's billing window watches for.
    ...(options.flow
      ? {
          "flow_data[type]": flow,
          [`flow_data[${flow}][subscription]`]: subscription[0]!.id,
          "flow_data[after_completion][type]": "redirect",
          "flow_data[after_completion][redirect][return_url]": `${modelPlanOrigin()}/account?model_plan=${options.flow === "change" ? "updated" : "ending"}`,
        }
      : {}),
  })
  // A double click within the minute opens the same portal session; Stripe refuses a key reused with other values,
  // so the key covers everything the request says.
  const result = await modelPlanStripe(
    "billing_portal/sessions",
    {
      method: "POST",
      body,
      idempotency: `vector-portal-${digest(body.toString())}-${Math.floor((options.now ?? Date.now()) / 60_000)}`,
    },
    fetcher,
  )
  if (typeof result.url !== "string" || !result.url.startsWith("https://billing.stripe.com/"))
    throw new ApiError(502, "BILLING_PORTAL_UNAVAILABLE", "Subscription management could not be opened.")
  return { url: result.url }
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
  await withAccountLease(
    id,
    async (verify) => {
      const account = await readModelPlanAccount(id, fetcher)
      if (!account) return
      // Persist closure before external cleanup so retries cannot open new
      // checkout sessions or re-enable a key while identity deletion proceeds.
      await verify()
      await saveAccount(id, { ...account, closing: true }, fetcher)
      if (account.key)
        await openRouterManagement(`/${encodeURIComponent(account.key.hash)}`, { disabled: true }, fetcher, "PATCH")
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
        await modelPlanStripe(
          `checkout/sessions/${encodeURIComponent(session.id)}/expire`,
          { method: "POST", idempotency: `vector-expire-${session.id}` },
          fetcher,
        )
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

/** A short, fixed-length digest for idempotency keys, so they stay well under Stripe's 255 characters. */
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}
