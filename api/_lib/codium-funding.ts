import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey, owedKeyName } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { MODEL_PLAN_ROOT, modelPlans, modelTopups } from "./model-plan-config.js"
import { stripeRecord } from "./model-plan-stripe.js"
import { persistentStore } from "./persistent-store.js"

/**
 * Whether Vector's OpenRouter balance can pay for every Codium credit customers still hold or are buying. OpenRouter
 * sells credits only through its dashboard (its auto top-up refills the balance; there is no API to buy credits), so
 * Vector cannot fund itself. Instead this check compares the balance with what is owed and pauses new Codium sales,
 * and tells the owner, until the balance covers it again. Every amount here is in cents and private to the server and
 * the owner.
 */
const Funding = Schema.Struct({
  status: Schema.Literals(["open", "paused"]),
  // Why sales are paused: the balance is short of what is needed, or the check could not finish.
  reason: Schema.optional(Schema.Literals(["short", "unavailable"])),
  // The failed check's error code; the amounts of a failed check are unknown.
  error: Schema.optional(Schema.String),
  checkedAt: Schema.Number,
  since: Schema.Number,
  balance: Schema.NullOr(Schema.Number),
  owed: Schema.NullOr(Schema.Number),
  // Credits in checkouts opened recently, which may still be paid for (see reserveCodiumSale).
  reserved: Schema.optional(Schema.NullOr(Schema.Number)),
  required: Schema.NullOr(Schema.Number),
  keys: Schema.NullOr(Schema.Number),
  notifiedAt: Schema.optional(Schema.Number),
})
export type CodiumFunding = typeof Funding.Type

// Read at each call: the mode namespace comes from the environment.
const FUNDING_KEY = () => codiumKey("funding")
const LOCK_KEY = () => codiumKey("funding", "lock")
// One reservation per checkout, "<checkout's idempotency key>" -> "<lapses at>:<cents>". A buyer's new checkout gives
// back their earlier checkout's reservation only when that one can no longer be paid (it closed it, or Stripe had), so
// a buyer holds one unpaid open checkout of each kind while every purchase they paid for keeps counting.
const RESERVED_KEY = () => codiumKey("funding", "reserved")
// Drops lapsed reservations and the one given back (ARGV[3]) and adds up the others, leaving out ARGV[2]'s own, which a
// retry of the same checkout is reserving again.
const RESERVATIONS =
  "local reserved = 0 local entries = redis.call('HGETALL', KEYS[1]) for i = 1, #entries, 2 do local lapses, cents = string.match(entries[i + 1], '^(%d+):(%d+)$') if not lapses or tonumber(lapses) <= tonumber(ARGV[1]) or entries[i] == ARGV[3] then redis.call('HDEL', KEYS[1], entries[i]) elseif entries[i] ~= ARGV[2] then reserved = reserved + tonumber(cents) end end "
// Reserves ARGV[4] cents until ARGV[5] only while the reading's balance (ARGV[6]) covers what is owed (ARGV[7]), every
// other reservation and this one, with the margin (ARGV[8] percent plus ARGV[9] cents), all in one step so purchases
// made at the same moment cannot each pass against the same balance.
const RESERVE = `${RESERVATIONS}if tonumber(ARGV[6]) < math.ceil((tonumber(ARGV[7]) + reserved + tonumber(ARGV[4])) * (100 + tonumber(ARGV[8])) / 100) + tonumber(ARGV[9]) then return 0 end redis.call('HSET', KEYS[1], ARGV[2], ARGV[5] .. ':' .. ARGV[4]) return 1`
// The cron checks every ten minutes. A sale needs a reading from about one interval ago; an older one is stale, so the
// sale runs a check of its own first.
export const CODIUM_FUNDING_MAX_AGE_MS = 15 * 60_000
const REMINDER_MS = 24 * 60 * 60_000
// Bounds the key listing; an account this large needs a different store of what is owed.
const MAX_KEYS = 50_000

export async function readCodiumFunding(fetcher: typeof fetch = fetch) {
  const saved = await persistentStore(["GET", FUNDING_KEY()], fetcher)
  if (saved === null) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Funding))(saved))
}

/** Reads the balance and what is owed, opens or pauses sales, and emails the owner when that changes. */
export async function checkCodiumFunding(fetcher: typeof fetch = fetch, now = Date.now()) {
  const lease = randomUUID()
  // One check at a time, so a change of state sends one email.
  const lock = LOCK_KEY()
  if ((await persistentStore(["SET", lock, lease, "NX", "PX", 60_000], fetcher)) !== "OK")
    return { ...(await readCodiumFunding(fetcher)), notified: false, ran: false }
  return measureFunding(fetcher, now).finally(() =>
    persistentStore(
      [
        "EVAL",
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        lock,
        lease,
      ],
      fetcher,
    ).catch(() => undefined),
  )
}

async function measureFunding(fetcher: typeof fetch, now: number) {
  const previous = await readCodiumFunding(fetcher)
  // A check that cannot finish pauses sales at once: without a reading, selling could promise credits Vector cannot pay.
  const reading = await fundingReading(fetcher, now).then(
    (value) => ({
      ...value,
      status: value.balance >= value.required ? ("open" as const) : ("paused" as const),
      reason: value.balance >= value.required ? undefined : ("short" as const),
      error: undefined,
      failure: undefined,
    }),
    (failure: unknown) => ({
      status: "paused" as const,
      reason: "unavailable" as const,
      error: failure instanceof ApiError ? failure.code : "CODIUM_FUNDING_FAILED",
      balance: null,
      owed: null,
      reserved: null,
      required: null,
      keys: null,
      failure,
    }),
  )
  const changed = previous?.status !== reading.status || previous?.reason !== reading.reason
  const funding: CodiumFunding = {
    status: reading.status,
    reason: reading.reason,
    error: reading.error,
    checkedAt: now,
    since: previous?.status === reading.status ? previous.since : now,
    balance: reading.balance,
    owed: reading.owed,
    reserved: reading.reserved,
    required: reading.required,
    keys: reading.keys,
    notifiedAt: changed ? undefined : previous?.notifiedAt,
  }
  await persistentStore(["SET", FUNDING_KEY(), JSON.stringify(funding)], fetcher)
  // Tell the owner when sales pause or the reason changes, each day they stay paused, and when they reopen.
  const notify =
    funding.status === "paused"
      ? funding.notifiedAt === undefined || now - funding.notifiedAt >= REMINDER_MS
      : changed && previous !== undefined
  const notified = notify && (await emailOwner(funding, reading.failure, fetcher))
  if (notified) await persistentStore(["SET", FUNDING_KEY(), JSON.stringify({ ...funding, notifiedAt: now })], fetcher)
  // The scheduled job still reports the failure, so its log shows the check did not run.
  if (funding.reason === "unavailable") throw reading.failure
  return { ...funding, notifiedAt: notified ? now : funding.notifiedAt, notified, ran: true }
}

/**
 * Sales stay open only while the balance covers what customers hold, the credits in checkouts that may still be paid
 * for, and one more of the largest purchase, with the margin. The last term means that once reserveCodiumSale has had
 * to refuse a purchase, the next check pauses sales and tells the owner, unless the balance has grown since.
 */
async function fundingReading(fetcher: typeof fetch, now: number) {
  const margin = fundingMargin()
  const largest = Math.max(0, ...[...modelPlans(), ...modelTopups()].map((value) => Math.round(value.credits * 100)))
  const balance = await openRouterBalance(fetcher)
  const owed = await creditsOwed(fetcher, now)
  const reserved = Number(
    await persistentStore(["EVAL", `${RESERVATIONS}return reserved`, 1, RESERVED_KEY(), now, "", ""], fetcher),
  )
  if (!Number.isSafeInteger(reserved)) throw unavailable()
  return {
    balance,
    owed: owed.cents,
    reserved,
    required: Math.ceil(((owed.cents + reserved + largest) * (100 + margin.percent)) / 100) + margin.cents,
    keys: owed.keys,
  }
}

/**
 * New subscriptions and top-ups need a check from the last CODIUM_FUNDING_MAX_AGE_MS that found the balance covering
 * what is owed. A failed check is saved as a pause, and a sale that finds the reading stale runs a check first and
 * refuses unless it succeeds: selling credits Vector may not be able to pay for is the failure to avoid. Credits
 * already bought keep working either way. Returns the reading reserveCodiumSale measures the purchase against.
 */
export async function requireCodiumSales(fetcher: typeof fetch = fetch, now = Date.now()) {
  const saved = await readCodiumFunding(fetcher)
  const funding =
    saved && now - saved.checkedAt < CODIUM_FUNDING_MAX_AGE_MS
      ? saved
      : await checkCodiumFunding(fetcher, now).catch(() => undefined)
  if (
    funding?.status !== "open" ||
    funding.checkedAt === undefined ||
    now - funding.checkedAt >= CODIUM_FUNDING_MAX_AGE_MS ||
    typeof funding.balance !== "number" ||
    typeof funding.owed !== "number"
  )
    throw salesPaused()
  return { balance: funding.balance, owed: funding.owed }
}

/**
 * Holds a purchase's credits against the balance from when its checkout opens until it can no longer be paid, plus
 * long enough for a check to count a paid purchase among what is owed. Purchases since the last check would otherwise
 * each pass against the same reading and together sell more than the balance covers. `sale.id` is the checkout's own
 * idempotency key, and `sale.released` names the reservation of an earlier checkout this one closed: only a checkout
 * that can no longer be paid gives its reservation back. A paid purchase counts twice until its reservation lapses,
 * which errs towards pausing.
 */
export async function reserveCodiumSale(
  reading: { balance: number; owed: number },
  sale: { id: string; credits: number; closes: number; released?: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  const margin = fundingMargin()
  const reserved = await persistentStore(
    [
      "EVAL",
      RESERVE,
      1,
      RESERVED_KEY(),
      now,
      sale.id,
      sale.released ?? "",
      Math.round(sale.credits * 100),
      sale.closes + 2 * CODIUM_FUNDING_MAX_AGE_MS,
      reading.balance,
      reading.owed,
      margin.percent,
      margin.cents,
    ],
    fetcher,
  )
  if (reserved !== 1) throw salesPaused()
}

function salesPaused() {
  return new ApiError(
    503,
    "CODIUM_SALES_PAUSED",
    "New Codium purchases are temporarily unavailable. Credits you already have keep working. Please try again later.",
  )
}

async function openRouterBalance(fetcher: typeof fetch) {
  const data = await openRouter("/credits", fetcher)
  if (
    !stripeRecord(data) ||
    typeof data.total_credits !== "number" ||
    typeof data.total_usage !== "number" ||
    !Number.isFinite(data.total_credits) ||
    !Number.isFinite(data.total_usage)
  )
    throw unavailable()
  return Math.floor((data.total_credits - data.total_usage) * 100)
}

/** What every enabled, unexpired Codium key could still spend: its credit limit less its usage. */
async function creditsOwed(fetcher: typeof fetch, now: number) {
  const owed = (await codiumKeys(fetcher)).filter(
    (key) =>
      key.disabled !== true &&
      typeof key.name === "string" &&
      owedKeyName(key.name) &&
      typeof key.limit === "number" &&
      Number.isFinite(key.limit) &&
      (key.expires_at === null ||
        key.expires_at === undefined ||
        (typeof key.expires_at === "string" && Date.parse(key.expires_at) > now)),
  )
  return {
    keys: owed.length,
    cents: owed.reduce(
      (sum, key) =>
        sum +
        Math.max(0, Math.ceil((Number(key.limit) - (typeof key.usage === "number" ? key.usage : 0)) * 100 - 1e-6)),
      0,
    ),
  }
}

async function codiumKeys(
  fetcher: typeof fetch,
  offset = 0,
  seen = new Set<unknown>(),
): Promise<Record<string, unknown>[]> {
  // Without every key, what is owed would read low and could keep sales open, so a listing cut short fails, as does
  // one that repeats a page instead of moving on.
  if (offset >= MAX_KEYS) throw unavailable()
  const data = await openRouter(`/keys?offset=${offset}`, fetcher)
  if (!Array.isArray(data)) throw unavailable()
  const keys = data.filter(stripeRecord)
  if (!keys.length) return []
  if (keys.some((key) => typeof key.hash !== "string" || seen.has(key.hash))) throw unavailable()
  keys.forEach((key) => seen.add(key.hash))
  return [...keys, ...(await codiumKeys(fetcher, offset + data.length, seen))]
}

/** The management key reads the account's balance and its keys. */
async function openRouter(path: string, fetcher: typeof fetch) {
  const response = await fetcher(`${MODEL_PLAN_ROOT}${path}`, {
    headers: { authorization: `Bearer ${process.env.OPENROUTER_MANAGEMENT_KEY ?? ""}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  const body: unknown = response?.ok ? await response.json().catch(() => undefined) : undefined
  if (!stripeRecord(body)) throw unavailable()
  return body.data
}

function fundingMargin() {
  const percent = Number(process.env.CODIUM_FUNDING_MARGIN_PERCENT?.trim() || 10)
  const dollars = Number(process.env.CODIUM_FUNDING_MARGIN_USD?.trim() || 20)
  if (!Number.isFinite(percent) || percent < 0 || percent > 300 || !Number.isFinite(dollars) || dollars < 0)
    throw new ApiError(503, "CODIUM_FUNDING_CONFIGURATION", "The Codium funding margin is not configured correctly.")
  return { percent, cents: Math.round(dollars * 100) }
}

async function emailOwner(funding: CodiumFunding, failure: unknown, fetcher: typeof fetch) {
  const key = process.env.RESEND_API_KEY?.trim()
  const from = process.env.VECTOR_PURCHASE_EMAIL_FROM?.trim()
  const to = process.env.CODIUM_OWNER_EMAIL?.trim() || process.env.VECTOR_BUG_REPORT_TO?.trim()
  if (!key || !from || !to) return false
  const money = (cents: number | null) => (cents === null ? "unknown" : `$${(cents / 100).toFixed(2)}`)
  const amounts = [
    `OpenRouter balance: ${money(funding.balance)}`,
    `Credits customers still hold: ${money(funding.owed)} across ${funding.keys} keys`,
    `Credits in checkouts that may still be paid: ${money(funding.reserved ?? null)}`,
    `Needed, with room for the largest purchase and the margin: ${money(funding.required)}`,
  ]
  const reopen =
    "Credits customers already bought keep working. Sales reopen by themselves at the first check that reads the balance and finds it covers what is needed; checks run every 10 minutes."
  const message =
    funding.status === "open"
      ? {
          subject: "Vector Codium sales reopened",
          lines: [
            "Vector Codium is selling subscriptions and top-ups again. Vector's OpenRouter balance covers the credits customers hold or are buying, room for the largest purchase, and the safety margin.",
            "",
            ...amounts,
          ],
        }
      : funding.reason === "unavailable"
        ? {
            subject: "Vector Codium sales paused: the funding check could not finish",
            lines: [
              `Vector Codium has paused new subscriptions and top-ups because the funding check could not finish: ${failure instanceof ApiError ? failure.message : "it failed unexpectedly."}`,
              "",
              reopen,
              "If this lasts, check OpenRouter's status, OPENROUTER_MANAGEMENT_KEY and the CODIUM_FUNDING_* settings.",
            ],
          }
        : {
            subject: `Vector Codium sales paused: OpenRouter is short ${money((funding.required ?? 0) - (funding.balance ?? 0))}`,
            lines: [
              "Vector Codium has paused new subscriptions and top-ups. Vector's OpenRouter balance cannot cover the credits customers hold or are buying, room for the largest purchase, and the safety margin.",
              "",
              ...amounts,
              `Short by: ${money((funding.required ?? 0) - (funding.balance ?? 0))}`,
              "",
              reopen,
              "Add credits at https://openrouter.ai/settings/credits, or raise the auto top-up threshold above the amount needed.",
            ],
          }
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to, subject: message.subject, text: message.lines.join("\n") }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  return response?.ok === true
}

function unavailable() {
  return new ApiError(503, "CODIUM_FUNDING_UNAVAILABLE", "Vector's OpenRouter balance could not be read.")
}
