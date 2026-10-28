import { createHash, randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { codiumKey } from "./codium-keys.js"
import { ApiError } from "./http.js"
import { persistentStore } from "./persistent-store.js"

/*
 * A Codium account's pool: the month's model spend its OpenRouter key may make, counted in integer micro-dollars
 * (1 USD = 1,000,000). Contract §4.7 and invariants M1–M3:
 *
 * - total     = credits + carry                         (what the month holds; carry comes with an upgrade, WP A09)
 * - spent     = key usage + debits                      (debits: hosted blocks and other charges made off OpenRouter)
 * - limit     = credits + carry − applied debits        (the key's limit, the hard cap, M1)
 * - available = credits + carry − applied debits − usage − held   (M3)
 *
 * A debit is written unapplied with a hold of the same amount in the pool's held set, and stays held until the key's
 * limit has been lowered by it (applied), so an unapplied debit is counted once, as held, and an applied one once, in
 * the limit. Every place that decides whether the pool can pay (the gateway's fast path, provisioning,
 * `requireMonthlyCredits`, holds for hosted and other charges, and status) works from these figures.
 *
 * This module holds the arithmetic, the store records and the scripts. The account-level operations that need the
 * account's lease and its OpenRouter key (`holdPool`, `applyPoolDebits`, `drainDebitApplies`) are in
 * model-plan-account.ts beside the provisioning they share.
 */

export const MICRO_PER_USD = 1_000_000
/** A key's limit is PATCHed in whole cents and matches what it should be when within half a cent (M1). */
export const HALF_CENT_MICRO = 5_000
/** The gateway gives a provider request 600 seconds; its hold lapses a minute after that. */
export const MODEL_HOLD_MS = 660_000
/**
 * The provider adds a finished request to the key's usage a little after the answer ends, so its charge stays held
 * this long, and a request sent meanwhile cannot spend it a second time.
 */
export const SETTLED_HOLD_MS = 30_000
/** The longest hold a pool charge may ask for: a 12-hour cloud-computer job with room to settle. */
export const MAX_POOL_HOLD_MS = 2 * 86_400_000
/** An unapplied debit stays held this long, past the end of the month it belongs to, so it never stops counting. */
export const DEBIT_HOLD_MS = 35 * 86_400_000
/** How long after its key's period ends a key's debits are kept, for the owner's audits and the drift sweep. */
export const DEBITS_KEEP_MS = 40 * 86_400_000
/** A debit that could not be applied at once is retried after this long (outbox action `debit-apply`). */
export const DEBIT_RETRY_MS = 60_000
export const DEBIT_APPLY_ACTION = "debit-apply"

/**
 * What a hold or charge pays for: the purposes clients send with chat (`X-Vector-Purpose`, contract §4.9) and the run
 * services. It is part of every held member, so a later admission step can share the pool out by purpose.
 */
export const POOL_PURPOSES = [
  "chat",
  "title",
  "brain",
  "review",
  "judge",
  "race",
  "playbook",
  "task",
  "cloud-agents",
  "hosted",
] as const
export type PoolPurpose = (typeof POOL_PURPOSES)[number]

export function isPoolPurpose(value: unknown): value is PoolPurpose {
  return POOL_PURPOSES.some((purpose) => purpose === value)
}

// ── Amounts ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dollars to whole micro-dollars, to the nearest one. */
export function usdToMicro(usd: number) {
  if (!Number.isFinite(usd)) throw new RangeError("A Codium amount must be a finite number of dollars.")
  return Math.round(usd * MICRO_PER_USD)
}

/** Dollars to whole micro-dollars, never fewer: a hold must cover everything the request could cost. */
export function usdToMicroCeil(usd: number) {
  if (!Number.isFinite(usd)) throw new RangeError("A Codium amount must be a finite number of dollars.")
  return Math.ceil(usd * MICRO_PER_USD - 1e-6)
}

export function microToUsd(micro: number) {
  return micro / MICRO_PER_USD
}

/** The limit an OpenRouter key is given for `micro`: whole cents, never below zero. */
export function limitUsd(micro: number) {
  return Math.round(Math.max(0, micro) / 10_000) / 100
}

/**
 * Whether a key's limit, as OpenRouter reports it in dollars, is what the pool says it should be. The limit is set in
 * whole cents, so anything within half a cent matches: 73.94 for an expected 73.936 is left alone.
 */
export function limitMatches(limit: unknown, expectedMicro: number) {
  return (
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    Math.abs(usdToMicro(limit) - Math.max(0, expectedMicro)) <= HALF_CENT_MICRO
  )
}

/** What a key's own allowance is made of. */
export type PoolBase = { creditsMicro: number; carryMicro: number }

/** What the store holds against one key: live holds, and the debits already applied to its limit or still pending. */
export type PoolLedger = { heldMicro: number; appliedMicro: number; pendingMicro: number }

export const EMPTY_LEDGER: PoolLedger = Object.freeze({ heldMicro: 0, appliedMicro: 0, pendingMicro: 0 })

/** The key's limit: credits plus carry, less every debit already applied to it (§4.7 `expectedLimit`). */
export function expectedLimitMicro(base: PoolBase, appliedDebitsMicro: number) {
  return Math.max(0, base.creditsMicro + base.carryMicro - appliedDebitsMicro)
}

/** Every figure of one pool, from the key's usage and the store's ledger. */
export function poolFigures(base: PoolBase, usageMicro: number, ledger: PoolLedger) {
  const totalMicro = base.creditsMicro + base.carryMicro
  const debitsMicro = ledger.appliedMicro + ledger.pendingMicro
  return {
    totalMicro,
    spentMicro: usageMicro + debitsMicro,
    limitMicro: expectedLimitMicro(base, ledger.appliedMicro),
    /** What is left of the month, ignoring holds: what status shows as the share left. */
    remainingMicro: totalMicro - usageMicro - debitsMicro,
    /** What a new hold may take (M3). A pending debit is in `heldMicro`, so it is counted once. */
    availableMicro: totalMicro - ledger.appliedMicro - usageMicro - ledger.heldMicro,
  }
}

/**
 * The share of the month's pool spent, as a whole percent between 0 and 1: (usage + debits) / (credits + carry).
 * Holds are not spent, so a running request does not move it; the share left is `1 − poolShareUsed(...)`, which keeps
 * used + left at exactly 100 (H5). A pool with nothing in it reads as used up.
 */
export function poolShareUsed(figures: { totalMicro: number; spentMicro: number }) {
  if (!(figures.totalMicro > 0)) return 1
  return Math.min(100, Math.max(0, Math.round((figures.spentMicro / figures.totalMicro) * 100))) / 100
}

// ── Store records ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The pool's held set: one member per hold, scored by when it lapses. */
export const heldKey = (pool: string) => codiumKey("held", pool)
/** The debits charged against one key (ref → debit). Debits live only here, never in the account record. */
export const debitsKey = (account: string, keyHash: string) => codiumKey("debits", account, keyHash)
/** Keys with a debit still to apply, scored by when to try again: the outbox action `debit-apply` drains it. */
export const debitApplyKey = () => codiumKey(DEBIT_APPLY_ACTION)
const debitApplyMember = (account: string, keyHash: string) => `${account}:${keyHash}`

const TICKET = /^[A-Za-z0-9-]{1,64}$/
const RUN = /^[A-Za-z0-9_.-]{1,128}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/
const MEMBER = /^([A-Za-z0-9-]{1,64}):([a-z][a-z0-9-]{0,31}):([A-Za-z0-9_.-]{1,128}):(\d{1,15})$/

/** A held member, `<ticket>:<purpose>:<runId or ->:<micro>` (§4.6). */
export function holdMember(ticket: string, purpose: PoolPurpose, run: string | undefined, micro: number) {
  if (!TICKET.test(ticket) || !isPoolPurpose(purpose) || !Number.isSafeInteger(micro) || micro < 0)
    throw invalidCharge()
  if (run !== undefined && (!RUN.test(run) || run === "-")) throw invalidCharge()
  return `${ticket}:${purpose}:${run ?? "-"}:${micro}`
}

export function parseHoldMember(member: string) {
  const match = MEMBER.exec(member)
  if (!match) return undefined
  return {
    ticket: match[1]!,
    purpose: match[2]!,
    run: match[3] === "-" ? undefined : match[3],
    micro: Number(match[4]),
  }
}

export function validRunId(run: string | undefined) {
  return run === undefined || (RUN.test(run) && run !== "-")
}

export function validDebitRef(ref: string) {
  return REF.test(ref)
}

// `micro` and `applied` are read by the scripts below as text ("micro":<digits>, "applied":true|false), so a debit is
// always written by JSON.stringify, which puts no space after a colon.
const Micro = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Debit = Schema.Struct({
  micro: Micro,
  applied: Schema.Boolean,
  // The held member that keeps this debit counted until it is applied.
  hold: Schema.String,
  purpose: Schema.String,
  run: Schema.optional(Schema.String),
  at: Schema.Number,
})
export type PoolDebit = typeof Debit.Type & { ref: string }

// ── Scripts ────────────────────────────────────────────────────────────────────────────────────────────────────────

// The sum of the held set's members (KEYS[1]), each one's amount being its last field.
const HELD_SUM =
  "local held = 0 for _, member in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do held = held + (tonumber(string.match(member, ':(%d+)$')) or 0) end "
// The sum of the debits (KEYS[2]) already applied to the key's limit.
const APPLIED_SUM = `local applied = 0 local debits = redis.call('HGETALL', KEYS[2]) for i = 2, #debits, 2 do if string.find(debits[i], '"applied":true', 1, true) then applied = applied + (tonumber(string.match(debits[i], '"micro":(%d+)')) or 0) end end `
// A set's lifetime only ever grows: a short hold never cuts short a longer one already in it.
const growTtl = (key: string, ms: string) =>
  `if redis.call('PTTL', ${key}) < tonumber(${ms}) then redis.call('PEXPIRE', ${key}, ${ms}) end `

/**
 * HOLD. Drops lapsed holds and adds this one (ARGV[5], lapsing at ARGV[4]) only while the pool's base (ARGV[2]:
 * credits + carry − usage) less the applied debits and every live hold covers it (ARGV[3]), in one step, so requests
 * and charges made at the same moment cannot each pass against the same balance. The set lives at least ARGV[6] ms.
 */
const HOLD = `redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) ${HELD_SUM}${APPLIED_SUM}if tonumber(ARGV[2]) - applied - held < tonumber(ARGV[3]) then return 0 end redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5]) ${growTtl("KEYS[1]", "ARGV[6]")}return 1`

/** SETTLE. A finished model request's hold (ARGV[1]) becomes its charge (ARGV[3], lapsing at ARGV[2]). */
const SETTLE = `redis.call('ZREM', KEYS[1], ARGV[1]) redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3]) ${growTtl("KEYS[1]", "ARGV[4]")}return 1`

/**
 * DEBIT. A pool charge's hold (ARGV[1]) becomes an unapplied debit (ref ARGV[2], record ARGV[3]) held by a member of
 * its own amount (ARGV[5], lapsing at ARGV[4]) until it is applied, and the key is queued for `debit-apply` (member
 * ARGV[8] at ARGV[9], or earlier if it already is). A ref already recorded is not recorded again (0): the held set is
 * looked at only to give back the hold this settle came with, and never the member that keeps the recorded debit
 * counted, so a settle retried while its debit is still pending cannot drop that debit's hold.
 */
const DEBIT = `local recorded = redis.call('HGET', KEYS[2], ARGV[2]) if recorded then if not string.find(recorded, '"hold":"' .. ARGV[1] .. '"', 1, true) then redis.call('ZREM', KEYS[1], ARGV[1]) end return 0 end redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) redis.call('ZREM', KEYS[1], ARGV[1]) redis.call('PEXPIREAT', KEYS[2], ARGV[7]) redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5]) ${growTtl("KEYS[1]", "ARGV[6]")}local due = redis.call('ZSCORE', KEYS[3], ARGV[8]) if not due or tonumber(due) > tonumber(ARGV[9]) then redis.call('ZADD', KEYS[3], ARGV[9], ARGV[8]) end return 1`

/**
 * APPLY. Marks the named debits (ARGV[3], ARGV[5], …) applied and drops their holds (ARGV[4], ARGV[6], …), saves the
 * account record (ARGV[1], unless empty) with the limit just set, and takes the key off the `debit-apply` queue
 * (ARGV[2]) once none is left unapplied. Returns how many are still unapplied.
 */
const APPLY = `for i = 3, #ARGV, 2 do local debit = redis.call('HGET', KEYS[1], ARGV[i]) if debit then redis.call('HSET', KEYS[1], ARGV[i], (string.gsub(debit, '"applied":false', '"applied":true', 1))) end redis.call('ZREM', KEYS[2], ARGV[i + 1]) end if ARGV[1] ~= '' then redis.call('SET', KEYS[3], ARGV[1]) end local pending = 0 for _, debit in ipairs(redis.call('HVALS', KEYS[1])) do if string.find(debit, '"applied":false', 1, true) then pending = pending + 1 end end if pending == 0 then redis.call('ZREM', KEYS[4], ARGV[2]) end return pending`

/** READ. The live holds (lapsing after ARGV[1]) and the applied and pending debits, without changing anything. */
const READ = `local held = 0 for _, member in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. ARGV[1], '+inf')) do held = held + (tonumber(string.match(member, ':(%d+)$')) or 0) end local applied, pending = 0, 0 local debits = redis.call('HGETALL', KEYS[2]) for i = 2, #debits, 2 do local micro = tonumber(string.match(debits[i], '"micro":(%d+)')) or 0 if string.find(debits[i], '"applied":true', 1, true) then applied = applied + micro else pending = pending + micro end end return {held, applied, pending}`

/** DEBITS. One key's debits as a flat list of ref, record, … whatever protocol the store speaks. */
const DEBITS = "return redis.call('HGETALL', KEYS[1])"

/** The scripts, for the tests and any store fake that has to recognise them. */
export const POOL_SCRIPTS = Object.freeze({ HOLD, SETTLE, DEBIT, APPLY, READ, DEBITS })

// ── Store operations ───────────────────────────────────────────────────────────────────────────────────────────────

/** One hold in a pool's held set. */
export type PoolTicket = {
  account: string
  pool: string
  ticket: string
  member: string
  purpose: PoolPurpose
  run?: string
  micro: number
}

/**
 * Places a hold of `requiredMicro` on the pool when what is available covers it: `baseMicro` is the key's credits plus
 * carry less its usage, and the script takes off the applied debits and every live hold. Undefined when it does not.
 */
export async function placeHold(
  input: {
    account: string
    pool: string
    baseMicro: number
    requiredMicro: number
    purpose: PoolPurpose
    run?: string
    ttlMs: number
    now: number
  },
  fetcher: typeof fetch = fetch,
): Promise<PoolTicket | undefined> {
  if (
    !Number.isSafeInteger(input.baseMicro) ||
    !Number.isSafeInteger(input.requiredMicro) ||
    input.requiredMicro <= 0 ||
    !Number.isSafeInteger(input.ttlMs) ||
    input.ttlMs <= 0 ||
    input.ttlMs > DEBIT_HOLD_MS
  )
    throw invalidCharge()
  const ticket = randomUUID()
  const member = holdMember(ticket, input.purpose, input.run, input.requiredMicro)
  const held = await persistentStore(
    [
      "EVAL",
      HOLD,
      2,
      heldKey(input.pool),
      debitsKey(input.account, input.pool),
      input.now,
      input.baseMicro,
      input.requiredMicro,
      input.now + input.ttlMs,
      member,
      input.ttlMs,
    ],
    fetcher,
  )
  if (held !== 1) return undefined
  return {
    account: input.account,
    pool: input.pool,
    ticket,
    member,
    purpose: input.purpose,
    ...(input.run === undefined ? {} : { run: input.run }),
    micro: input.requiredMicro,
  }
}

/** Gives a hold back unspent: the request or block never reached anything that bills. */
export async function releaseHold(hold: PoolTicket, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZREM", heldKey(hold.pool), hold.member], fetcher)
}

/** A finished model request keeps only what it was charged, for SETTLED_HOLD_MS, until the key's usage shows it. */
export async function settleHold(hold: PoolTicket, chargedMicro: number, now: number, fetcher: typeof fetch = fetch) {
  const member = holdMember(hold.ticket, hold.purpose, hold.run, Math.max(0, chargedMicro))
  await persistentStore(
    ["EVAL", SETTLE, 1, heldKey(hold.pool), hold.member, now + SETTLED_HOLD_MS, member, SETTLED_HOLD_MS],
    fetcher,
  )
}

/**
 * The ticket of the held member that keeps one debit counted until it is applied: derived from the debit's ref, so it
 * is the same on every retry of that settle, differs for every other debit (two settles of one hold included), and can
 * never equal a hold's own ticket (a random UUID).
 */
export function debitHoldTicket(ref: string) {
  if (!validDebitRef(ref)) throw invalidCharge()
  return `debit-${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`
}

/**
 * Records what a pool charge cost as an unapplied debit on its key, keeps it held until it is applied, and queues the
 * key for `debit-apply`. False when `ref` was already recorded, which makes a retried settle harmless: the debit keeps
 * its own held member, and only the hold the retry came with is given back.
 */
export async function recordDebit(
  hold: PoolTicket,
  charge: { ref: string; micro: number; keepUntil: number; now: number },
  fetcher: typeof fetch = fetch,
) {
  if (!validDebitRef(charge.ref) || !Number.isSafeInteger(charge.micro) || charge.micro < 0) throw invalidCharge()
  const member = holdMember(debitHoldTicket(charge.ref), hold.purpose, hold.run, charge.micro)
  const debit: typeof Debit.Type = {
    micro: charge.micro,
    applied: false,
    hold: member,
    purpose: hold.purpose,
    ...(hold.run === undefined ? {} : { run: hold.run }),
    at: charge.now,
  }
  const recorded = await persistentStore(
    [
      "EVAL",
      DEBIT,
      3,
      heldKey(hold.pool),
      debitsKey(hold.account, hold.pool),
      debitApplyKey(),
      hold.member,
      charge.ref,
      JSON.stringify(debit),
      charge.now + DEBIT_HOLD_MS,
      member,
      DEBIT_HOLD_MS,
      Math.max(charge.keepUntil, charge.now + DEBIT_HOLD_MS),
      debitApplyMember(hold.account, hold.pool),
      charge.now + DEBIT_RETRY_MS,
    ],
    fetcher,
  )
  return recorded === 1
}

/** Every debit recorded against one key. A record that cannot be read fails closed: it might lower the limit. */
export async function readDebits(
  account: string,
  keyHash: string,
  fetcher: typeof fetch = fetch,
): Promise<PoolDebit[]> {
  const result = await persistentStore(["EVAL", DEBITS, 1, debitsKey(account, keyHash)], fetcher)
  if (!Array.isArray(result) || result.length % 2 !== 0) throw ledgerUnavailable()
  return Array.from({ length: result.length / 2 }, (_, index) => {
    const ref = result[index * 2]
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Debit))(result[index * 2 + 1])
    if (typeof ref !== "string" || Option.isNone(decoded)) throw ledgerUnavailable()
    return { ...decoded.value, ref }
  })
}

/** The live holds and the applied and pending debits of one key, read without changing anything. */
export async function readPoolLedger(
  account: string,
  keyHash: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<PoolLedger> {
  const result = await persistentStore(["EVAL", READ, 2, heldKey(keyHash), debitsKey(account, keyHash), now], fetcher)
  const values = Array.isArray(result) ? result.map(Number) : []
  if (values.length !== 3 || values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw ledgerUnavailable()
  return { heldMicro: values[0]!, appliedMicro: values[1]!, pendingMicro: values[2]! }
}

/**
 * Marks `pending` debits applied and drops their holds, saving `accountRecord` (a store key and its JSON) with the limit
 * just set in the same step. Callers hold the account's lease and have already set the key's limit. Returns how many
 * debits are still unapplied: ones recorded after `pending` was read.
 */
export async function markDebitsApplied(
  input: {
    account: string
    keyHash: string
    accountRecord?: { key: string; json: string }
    pending: readonly Pick<PoolDebit, "ref" | "hold">[]
  },
  fetcher: typeof fetch = fetch,
) {
  const left = await persistentStore(
    [
      "EVAL",
      APPLY,
      4,
      debitsKey(input.account, input.keyHash),
      heldKey(input.keyHash),
      input.accountRecord?.key ?? debitsKey(input.account, input.keyHash),
      debitApplyKey(),
      input.accountRecord?.json ?? "",
      debitApplyMember(input.account, input.keyHash),
      ...input.pending.flatMap((debit) => [debit.ref, debit.hold]),
    ],
    fetcher,
  )
  const count = Number(left)
  if (!Number.isSafeInteger(count) || count < 0) throw ledgerUnavailable()
  return count
}

/** Keys whose `debit-apply` is due, oldest first. */
export async function dueDebitApplies(now: number, limit: number, fetcher: typeof fetch = fetch) {
  const result = await persistentStore(
    ["ZRANGEBYSCORE", debitApplyKey(), "-inf", now, "LIMIT", 0, Math.max(1, Math.floor(limit))],
    fetcher,
  )
  if (!Array.isArray(result)) throw ledgerUnavailable()
  return result.flatMap((member) => {
    const match = typeof member === "string" ? /^([^:]+):(.+)$/.exec(member) : null
    return match ? [{ account: match[1]!, keyHash: match[2]! }] : []
  })
}

/** Takes a key off the `debit-apply` queue once nothing is left to apply. */
export async function finishDebitApply(account: string, keyHash: string, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZREM", debitApplyKey(), debitApplyMember(account, keyHash)], fetcher)
}

/** Tries a key's `debit-apply` again at `at`. */
export async function postponeDebitApply(account: string, keyHash: string, at: number, fetcher: typeof fetch = fetch) {
  await persistentStore(["ZADD", debitApplyKey(), "XX", at, debitApplyMember(account, keyHash)], fetcher)
}

function invalidCharge() {
  return new ApiError(500, "MODEL_PLAN_POOL_INVALID", "This Codium charge could not be held.")
}

function ledgerUnavailable() {
  return new ApiError(503, "MODEL_PLAN_POOL_UNAVAILABLE", "Your Codium usage could not be verified.")
}
