import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { RedisClient } from "bun"
import {
  DEBIT_HOLD_MS,
  DEBIT_RETRY_MS,
  holdMember,
  limitMatches,
  limitUsd,
  parseHoldMember,
  POOL_SCRIPTS,
  poolFigures,
  poolShareUsed,
  readDebits,
  readPoolLedger,
  usdToMicro,
  usdToMicroCeil,
} from "../api/_lib/codium-pool"
import {
  applyPoolDebits,
  drainDebitApplies,
  holdPool,
  modelPlanCredential,
  modelPlanStatus,
  protectModelPlanKey,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import { SNAPSHOT_SCRIPTS } from "../api/_lib/codium-snapshot"
import { modelPlanBalance } from "../api/_lib/model-plan-status"

// Invariants M1–M3 (WP A03): the OpenRouter key is the hard cap, spend is held before it starts, and what is available
// is one figure everywhere. Stripe and OpenRouter are fakes behind the injected fetcher. The store is a real Valkey when
// VECTOR_TEST_REDIS_URL is set (the CI lane), so the pool's Lua runs for real there; otherwise it is an in-memory store
// that runs the same scripts as TypeScript, step for step.

const user = { id: "77777777-7777-4777-8777-777777777777" }
const KV = "https://kv.pool-fixture.invalid"
const PRICES = [10, 50, 100, 200] as const
const CREDITS = { 10: "6", 50: "33", 100: "72", 200: "150" } as const
const HASH = "hash_pool1"
const HOUR = 3_600_000

const environment = [
  "MODEL_PLANS_ENABLED",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STRIPE_SECRET_KEY",
  "CODIUM_STRIPE_MODE",
  "CODIUM_TEST_CREDIT_CAP_USD",
  "VERCEL_ENV",
  "OPENROUTER_MANAGEMENT_KEY",
  "MODEL_PLAN_KEY_ENCRYPTION_SECRET",
  "MODEL_PLAN_MODELS_JSON",
  ...PRICES.flatMap((price) => [`MODEL_PLAN_${price}_CREDITS_USD`, `STRIPE_MODEL_PLAN_${price}_PRICE_ID`]),
]
const original = new Map(environment.map((name) => [name, process.env[name]]))

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────────

const database = process.env.VECTOR_TEST_REDIS_URL ? new RedisClient(process.env.VECTOR_TEST_REDIS_URL) : undefined

type Value =
  | { kind: "string"; value: string }
  | { kind: "hash"; value: Map<string, string> }
  | { kind: "zset"; value: Map<string, number> }
const memory = { data: new Map<string, Value>(), expires: new Map<string, number>() }

async function redis(command: readonly (string | number)[]): Promise<unknown> {
  if (database) return database.send(String(command[0]), command.slice(1).map(String))
  return memoryCommand(command.map(String))
}

function live(key: string) {
  const at = memory.expires.get(key)
  if (at !== undefined && at <= Date.now()) {
    memory.data.delete(key)
    memory.expires.delete(key)
  }
  return memory.data.get(key)
}
function remove(key: string) {
  memory.data.delete(key)
  memory.expires.delete(key)
}
function zset(key: string) {
  const value = live(key)
  if (value?.kind === "zset") return value.value
  const created = new Map<string, number>()
  memory.data.set(key, { kind: "zset", value: created })
  return created
}
function hash(key: string) {
  const value = live(key)
  if (value?.kind === "hash") return value.value
  const created = new Map<string, string>()
  memory.data.set(key, { kind: "hash", value: created })
  return created
}
// Redis deletes a set or hash, and its lifetime, when its last member goes.
function prune(key: string) {
  const value = memory.data.get(key)
  if (value && value.kind !== "string" && value.value.size === 0) remove(key)
}
function pttl(key: string) {
  if (!live(key)) return -2
  const at = memory.expires.get(key)
  return at === undefined ? -1 : at - Date.now()
}
const ordered = (set: Map<string, number>) => [...set].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
const bound = (value: string, side: "min" | "max") => {
  if (value === "-inf") return { at: -Infinity, open: false }
  if (value === "+inf") return { at: Infinity, open: false }
  return value.startsWith("(") ? { at: Number(value.slice(1)), open: true } : { at: Number(value), open: false }
}
function between(set: Map<string, number>, min: string, max: string) {
  const low = bound(min, "min")
  const high = bound(max, "max")
  return ordered(set).filter(
    ([, score]) => (low.open ? score > low.at : score >= low.at) && (high.open ? score < high.at : score <= high.at),
  )
}
const last = (member: string) => Number(/:(\d+)$/.exec(member)?.[1] ?? 0)
const microOf = (debit: string) => Number(/"micro":(\d+)/.exec(debit)?.[1] ?? 0)
function growTtl(key: string, ms: string) {
  if (pttl(key) < Number(ms)) memory.expires.set(key, Date.now() + Number(ms))
}

/** The pool's scripts as TypeScript, one line of Lua at a time, plus the account lease's two. */
const scripts = new Map<string, (keys: string[], argv: string[]) => unknown>([
  [
    POOL_SCRIPTS.HOLD,
    ([held, debits], [now, base, required, score, member, ttl]) => {
      const set = zset(held!)
      for (const [value, at] of set) if (at <= Number(now)) set.delete(value)
      const holding = [...set.keys()].reduce((sum, value) => sum + last(value), 0)
      const applied = [...hash(debits!).values()]
        .filter((value) => value.includes('"applied":true'))
        .reduce((sum, value) => sum + microOf(value), 0)
      prune(debits!)
      if (Number(base) - applied - holding < Number(required)) {
        prune(held!)
        return 0
      }
      set.set(member!, Number(score))
      growTtl(held!, ttl!)
      return 1
    },
  ],
  [
    POOL_SCRIPTS.SETTLE,
    ([held], [old, score, member, ttl]) => {
      const set = zset(held!)
      set.delete(old!)
      set.set(member!, Number(score))
      growTtl(held!, ttl!)
      return 1
    },
  ],
  [
    POOL_SCRIPTS.DEBIT,
    ([held, debits, due], [old, ref, record, score, member, ttl, expireAt, dueMember, dueAt]) => {
      zset(held!).delete(old!)
      prune(held!)
      const entries = hash(debits!)
      if (entries.has(ref!)) return 0
      entries.set(ref!, record!)
      memory.expires.set(debits!, Number(expireAt))
      zset(held!).set(member!, Number(score))
      growTtl(held!, ttl!)
      const queue = zset(due!)
      const current = queue.get(dueMember!)
      if (current === undefined || current > Number(dueAt)) queue.set(dueMember!, Number(dueAt))
      return 1
    },
  ],
  [
    POOL_SCRIPTS.APPLY,
    ([debits, held, account, due], [record, dueMember, ...pairs]) => {
      const entries = hash(debits!)
      for (let index = 0; index < pairs.length; index += 2) {
        const debit = entries.get(pairs[index]!)
        if (debit) entries.set(pairs[index]!, debit.replace('"applied":false', '"applied":true'))
        zset(held!).delete(pairs[index + 1]!)
        prune(held!)
      }
      if (record !== "") {
        memory.data.set(account!, { kind: "string", value: record! })
        memory.expires.delete(account!)
      }
      const pending = [...entries.values()].filter((value) => value.includes('"applied":false')).length
      prune(debits!)
      if (pending === 0) {
        zset(due!).delete(dueMember!)
        prune(due!)
      }
      return pending
    },
  ],
  [
    POOL_SCRIPTS.READ,
    ([held, debits], [now]) => {
      const holding = between(zset(held!), `(${now}`, "+inf").reduce((sum, [value]) => sum + last(value), 0)
      const values = [...hash(debits!).values()]
      const applied = values.filter((value) => value.includes('"applied":true'))
      const pending = values.filter((value) => !value.includes('"applied":true'))
      prune(held!)
      prune(debits!)
      return [holding, applied.reduce((s, v) => s + microOf(v), 0), pending.reduce((s, v) => s + microOf(v), 0)]
    },
  ],
  [
    POOL_SCRIPTS.DEBITS,
    ([debits]) => {
      const flat = [...hash(debits!)].flat()
      prune(debits!)
      return flat
    },
  ],
  [
    "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end; return redis.call('PTTL', KEYS[1])",
    ([key], [token]) => {
      const value = live(key!)
      return value?.kind === "string" && value.value === token ? pttl(key!) : -1
    },
  ],
  [
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0",
    ([key], [token]) => {
      const value = live(key!)
      if (value?.kind !== "string" || value.value !== token) return 0
      remove(key!)
      return 1
    },
  ],
  [
    // Reconcile's snapshot write (WP A05; test/codium-billing.test.ts covers it): only what these tests can see.
    SNAPSHOT_SCRIPTS.WRITE,
    ([snapshot, status, index, opened, outbox, ...items], argv) => {
      memory.data.set(snapshot!, { kind: "string", value: argv[0]! })
      memory.expires.delete(snapshot!)
      if (argv[6] !== "") memory.expires.set(snapshot!, Date.now() + Number(argv[6]))
      remove(status!)
      if (argv[2] === "1") zset(index!).set(argv[4]!, Number(argv[3]))
      else zset(index!).delete(argv[4]!)
      prune(index!)
      if (argv[5] !== "" && !live(opened!)) memory.data.set(opened!, { kind: "string", value: argv[5]! })
      items.forEach((key, position) => {
        memory.data.set(key, { kind: "string", value: argv[9 + position * 3]! })
        zset(outbox!).set(argv[7 + position * 3]!, Number(argv[8 + position * 3]))
      })
      return 1
    },
  ],
])

function memoryCommand(command: string[]): unknown {
  const [name, ...args] = command
  if (name === "FLUSHDB") {
    memory.data.clear()
    memory.expires.clear()
    return "OK"
  }
  if (name === "GET") {
    const value = live(args[0]!)
    return value?.kind === "string" ? value.value : null
  }
  if (name === "SET") {
    const [key, value, ...options] = args
    if (options.includes("NX") && live(key!)) return null
    memory.data.set(key!, { kind: "string", value: value! })
    memory.expires.delete(key!)
    const px = options.indexOf("PX")
    if (px >= 0) memory.expires.set(key!, Date.now() + Number(options[px + 1]))
    return "OK"
  }
  if (name === "PTTL") return pttl(args[0]!)
  if (name === "HSET") {
    hash(args[0]!).set(args[1]!, args[2]!)
    return 1
  }
  if (name === "ZADD") {
    const xx = args[1] === "XX"
    const [key, score, member] = xx ? [args[0], args[2], args[3]] : args
    const set = zset(key!)
    if (xx && !set.has(member!)) {
      prune(key!)
      return 0
    }
    set.set(member!, Number(score))
    return 1
  }
  if (name === "ZREM") {
    const set = zset(args[0]!)
    const removed = set.delete(args[1]!) ? 1 : 0
    prune(args[0]!)
    return removed
  }
  if (name === "ZRANGE") {
    const members = ordered(zset(args[0]!)).map(([member]) => member)
    prune(args[0]!)
    return members
  }
  if (name === "ZSCORE") {
    const score = zset(args[0]!).get(args[1]!)
    prune(args[0]!)
    return score === undefined ? null : String(score)
  }
  if (name === "ZRANGEBYSCORE") {
    const limit = args.indexOf("LIMIT")
    const found = between(zset(args[0]!), args[1]!, args[2]!).map(([member]) => member)
    prune(args[0]!)
    return limit >= 0 ? found.slice(Number(args[limit + 1]), Number(args[limit + 1]) + Number(args[limit + 2])) : found
  }
  if (name === "EVAL") {
    const [script, count, ...rest] = args
    const run = scripts.get(script!)
    if (!run) throw new Error(`Unexpected store script ${script!.slice(0, 60)}`)
    return run(rest.slice(0, Number(count)), rest.slice(Number(count)))
  }
  throw new Error(`Unexpected store command ${name}`)
}

// ── Stripe and OpenRouter ──────────────────────────────────────────────────────────────────────────────────────────

type Call = { method: string; path: string; body: Record<string, unknown> }
const world = {
  subscriptions: [] as Record<string, unknown>[],
  keys: new Map<string, Record<string, unknown>>(),
  openRouter: [] as Call[],
  failPatches: 0,
  stripe: 0,
}

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const body = init?.body === undefined || init.body === null ? "" : String(init.body)
  if (url.origin === KV) return Response.json({ result: await redis(JSON.parse(body) as (string | number)[]) })
  if (url.origin === "https://api.stripe.com") {
    world.stripe++
    if (url.pathname === "/v1/subscriptions") return Response.json({ data: world.subscriptions, has_more: false })
    throw new Error(`Unexpected Stripe request ${url.pathname}`)
  }
  if (url.origin === "https://openrouter.ai" && url.pathname.startsWith("/api/v1/keys")) {
    const method = init?.method ?? "GET"
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
    world.openRouter.push({ method, path: url.pathname, body: parsed })
    if (method === "POST") {
      const hash = `hash_pool${world.keys.size + 1}`
      const data = { ...parsed, hash, usage: 0, disabled: false }
      world.keys.set(hash, data)
      return Response.json({ key: `pool-secret-${world.keys.size}`, data })
    }
    const key = world.keys.get(url.pathname.split("/").at(-1)!)
    if (!key) return Response.json({ error: "Unknown key" }, { status: 404 })
    if (method === "PATCH") {
      if (world.failPatches > 0) {
        world.failPatches--
        return Response.json({ error: "fixture outage" }, { status: 503 })
      }
      Object.assign(key, parsed)
    }
    return Response.json({ data: key })
  }
  throw new Error(`Unexpected request to ${url.origin}`)
}) as typeof fetch

const patches = () => world.openRouter.filter((call) => call.method === "PATCH")

function period() {
  const start = Math.floor(Date.now() / 1000) - 3600
  return { start, end: start + 30 * 86_400 }
}

function subscription(price: (typeof PRICES)[number]) {
  const { start, end } = period()
  return {
    id: "sub_pool",
    customer: "cus_pool",
    status: "active",
    cancel_at_period_end: false,
    metadata: { vector_account_id: user.id },
    items: {
      data: [
        {
          quantity: 1,
          current_period_start: start,
          current_period_end: end,
          price: {
            id: `price_pool${price}`,
            active: true,
            currency: "usd",
            unit_amount: price * 100,
            recurring: { interval: "month", interval_count: 1 },
          },
        },
      ],
    },
    latest_invoice: {
      id: "in_pool",
      paid: true,
      status: "paid",
      amount_paid: price * 100,
      charge: { id: "ch_pool", paid: true, refunded: false, disputed: false, amount_refunded: 0 },
      lines: { data: [{ price: { id: `price_pool${price}` }, period: { start, end }, proration: false }] },
    },
  }
}

/**
 * A paid month on `price`'s plan whose key already exists: the account record as the pool keeps it, the OpenRouter key
 * at `limit` with `usage` spent, and `applied` debits already taken off it.
 */
async function seed(options: {
  price: (typeof PRICES)[number]
  limit: number
  usage?: number
  carryMicro?: number
  applied?: number[]
  legacy?: boolean
}) {
  const { start, end } = period()
  const credits = Number(CREDITS[options.price])
  const creditsMicro = usdToMicro(credits)
  const appliedMicro = (options.applied ?? []).reduce((sum, value) => sum + value, 0)
  const key = {
    hash: HASH,
    encrypted: protectModelPlanKey("pool-secret-1", `${user.id}:sub_pool:${start}`),
    subscription: "sub_pool",
    start,
    end,
    credits,
    ...(options.legacy
      ? {}
      : {
          creditsMicro,
          limitMicro: creditsMicro + (options.carryMicro ?? 0) - appliedMicro,
          ...(options.carryMicro
            ? {
                carry: {
                  micro: options.carryMicro,
                  fromSubscription: "sub_before",
                  fromStart: start - 600,
                  fromCharge: "ch_before",
                },
              }
            : {}),
        }),
  }
  await redis(["SET", `vector:codium:test:account:${user.id}`, JSON.stringify({ customer: "cus_pool", key })])
  for (const [index, micro] of (options.applied ?? []).entries())
    await redis([
      "HSET",
      `vector:codium:test:debits:${user.id}:${HASH}`,
      `seeded-${index}`,
      JSON.stringify({
        micro,
        applied: true,
        hold: `seed${index}:hosted:-:${micro}`,
        purpose: "hosted",
        at: Date.now(),
      }),
    ])
  world.subscriptions = [subscription(options.price)]
  world.keys.set(HASH, {
    hash: HASH,
    name: `Vector test ${user.id} sub_pool ${start}`,
    limit: options.limit,
    usage: options.usage ?? 0,
    disabled: false,
    limit_reset: null,
    include_byok_in_limit: true,
    expires_at: new Date(end * 1000).toISOString(),
  })
}

const heldMembers = async () => (await redis(["ZRANGE", `vector:codium:test:held:${HASH}`, 0, -1])) as string[]
const ledger = () => readPoolLedger(user.id, HASH, Date.now(), fetcher)
const status = async () => {
  const monthly = await modelPlanStatus(user.id, fetcher)
  return { monthly, balance: modelPlanBalance(monthly) }
}

beforeEach(async () => {
  environment.forEach((name) => delete process.env[name])
  Object.assign(process.env, {
    MODEL_PLANS_ENABLED: "true",
    KV_REST_API_URL: KV,
    KV_REST_API_TOKEN: "fixture-kv-token",
    STRIPE_SECRET_KEY: "sk_test_pool_fixture",
    CODIUM_STRIPE_MODE: "test",
    // These tests use the plans' full credits; test mode would otherwise cap every key at $0.50.
    CODIUM_TEST_CREDIT_CAP_USD: "200",
    VERCEL_ENV: "preview",
    OPENROUTER_MANAGEMENT_KEY: "fixture-management-key",
    MODEL_PLAN_KEY_ENCRYPTION_SECRET: "cd".repeat(32),
  })
  for (const price of PRICES) {
    process.env[`MODEL_PLAN_${price}_CREDITS_USD`] = CREDITS[price]
    process.env[`STRIPE_MODEL_PLAN_${price}_PRICE_ID`] = `price_pool${price}`
  }
  await redis(["FLUSHDB"])
  world.subscriptions = []
  world.keys.clear()
  world.openRouter.length = 0
  world.failPatches = 0
  world.stripe = 0
})
afterEach(() =>
  original.forEach((value, name) => {
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }),
)

// ── Arithmetic ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("pool arithmetic", () => {
  test("amounts are whole micro-dollars, holds never round down, and limits are set in whole cents", () => {
    expect(usdToMicro(0.000031)).toBe(31)
    expect(usdToMicro(4.97)).toBe(4_970_000)
    expect(usdToMicroCeil(0.012288)).toBe(12_288)
    expect(usdToMicroCeil(0.0000001)).toBe(1)
    expect(usdToMicroCeil(0.001)).toBe(1_000)
    expect(limitUsd(73_936_000)).toBe(73.94)
    expect(limitUsd(73_935_000)).toBe(73.94)
    expect(limitUsd(-5)).toBe(0)
    expect(() => usdToMicro(Number.NaN)).toThrow()
  })

  test("a limit within half a cent matches, so a key set in cents is never PATCHed again", () => {
    expect(limitMatches(73.94, 73_936_000)).toBe(true)
    expect(limitMatches(73.93, 73_936_000)).toBe(false)
    expect(limitMatches(73.95, 73_936_000)).toBe(false)
    // The value a half-cent target is PATCHed to matches it.
    expect(limitMatches(limitUsd(73_935_000), 73_935_000)).toBe(true)
    expect(limitMatches("73.94", 73_936_000)).toBe(false)
    expect(limitMatches(undefined, 0)).toBe(false)
  })

  test("every figure comes from credits, carry, usage, debits and holds", () => {
    const figures = poolFigures({ creditsMicro: 72_000_000, carryMicro: 2_500_000 }, 10_000_000, {
      heldMicro: 1_500_000,
      appliedMicro: 564_000,
      pendingMicro: 1_000_000,
    })
    expect(figures).toEqual({
      totalMicro: 74_500_000,
      spentMicro: 11_564_000,
      limitMicro: 73_936_000,
      remainingMicro: 62_936_000,
      // The pending debit is among the holds, so it is counted once.
      availableMicro: 74_500_000 - 564_000 - 10_000_000 - 1_500_000,
    })
    expect(poolShareUsed(figures)).toBe(0.16)
  })

  test("the share used is a whole percent, and used + left is exactly 100", () => {
    for (let spent = 0; spent <= 6_000_000; spent += 37_501) {
      const used = poolShareUsed({ totalMicro: 6_000_000, spentMicro: spent })
      expect(Math.round(used * 100) / 100).toBe(used)
      expect(Math.round(used * 100) + Math.round((1 - used) * 100)).toBe(100)
    }
    expect(poolShareUsed({ totalMicro: 6_000_000, spentMicro: 9_000_000 })).toBe(1)
    expect(poolShareUsed({ totalMicro: 0, spentMicro: 0 })).toBe(1)
  })

  test("a held member is <ticket>:<purpose>:<runId or ->:<micro>", () => {
    expect(holdMember("ticket-1", "hosted", undefined, 12_288)).toBe("ticket-1:hosted:-:12288")
    expect(holdMember("ticket-1", "cloud-agents", "run_7", 1)).toBe("ticket-1:cloud-agents:run_7:1")
    expect(parseHoldMember("ticket-1:cloud-agents:run_7:1")).toEqual({
      ticket: "ticket-1",
      purpose: "cloud-agents",
      run: "run_7",
      micro: 1,
    })
    expect(parseHoldMember("ticket-1:0.012288")).toBeUndefined()
    expect(() => holdMember("ticket-1", "hosted", "a:b", 1)).toThrow()
    expect(() => holdMember("ticket-1", "hosted", "-", 1)).toThrow()
    expect(() => holdMember("ticket-1", "hosted", undefined, 0.5)).toThrow()
  })
})

// ── M1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M1: the provider key is the hard cap", () => {
  test("a key keeps its carry and debits, is never repaired to the plan's credits, and 73.936 vs 73.94 is no PATCH", async () => {
    // Max: 72 of credits, 2.50 carried from an upgrade, 0.564 of hosted debits applied: 73.936, set as 73.94.
    await seed({ price: 100, limit: 73.94, usage: 10, carryMicro: 2_500_000, applied: [564_000] })
    await reconcileModelPlanAccount(user.id, fetcher)
    await (await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)).release()
    expect(patches()).toEqual([])
    expect(world.keys.get(HASH)?.limit).toBe(73.94)

    // A key whose limit drifted, here back to the plan's credits, is set to the pool's limit, not to the credits.
    world.keys.get(HASH)!.limit = 72
    await (await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)).release()
    expect(patches()).toHaveLength(1)
    expect(patches()[0]!.body).toMatchObject({ limit: 73.94, disabled: false })
    expect(world.keys.get(HASH)?.limit).toBe(73.94)
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(patches()).toHaveLength(1)
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({
      creditsMicro: 72_000_000,
      carry: { micro: 2_500_000 },
      limitMicro: 73_936_000,
    })
  })

  test("a switched-off key is switched back on at the pool's limit, its usage kept", async () => {
    await seed({ price: 10, limit: 5.5, usage: 2, applied: [500_000] })
    world.keys.get(HASH)!.disabled = true
    await (await modelPlanCredential(user.id, fetcher, Date.now(), 0.01)).release()
    expect(world.keys.get(HASH)).toMatchObject({ disabled: false, limit: 5.5, usage: 2 })
    expect(patches().map((call) => call.body.limit)).toEqual([5.5])
  })

  test("a new month's key starts at its credits in whole micro-dollars, and a record from before them is filled in", async () => {
    world.subscriptions = [subscription(50)]
    await redis(["SET", `vector:codium:test:account:${user.id}`, JSON.stringify({ customer: "cus_pool" })])
    await modelPlanCredential(user.id, fetcher)
    const created = world.openRouter.filter((call) => call.method === "POST")
    expect(created.map((call) => call.body.limit)).toEqual([33])
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({
      credits: 33,
      creditsMicro: 33_000_000,
      limitMicro: 33_000_000,
    })

    // A record written before the pool counted in micro-dollars has no debits: its limit is its credits.
    world.openRouter.length = 0
    await seed({ price: 100, limit: 72, legacy: true })
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(patches()).toEqual([])
    expect((await readModelPlanAccount(user.id, fetcher))?.key).toMatchObject({
      creditsMicro: 72_000_000,
      limitMicro: 72_000_000,
    })
  })
})

// ── M2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M2: spend is held before it starts", () => {
  test("model requests and pool charges hold in one set, and a 12 h hold survives a later 660 s one", async () => {
    await seed({ price: 100, limit: 72 })
    const block = await holdPool(user.id, 1, 12 * HOUR, "hosted", { fetcher, runId: "job_1" })
    const request = await modelPlanCredential(user.id, fetcher, Date.now(), 0.5)
    const members = (await heldMembers()).map((member) => parseHoldMember(member))
    expect(members.map((member) => member?.purpose).sort()).toEqual(["chat", "hosted"])
    expect(members.find((member) => member?.purpose === "hosted")).toMatchObject({ run: "job_1", micro: 1_000_000 })
    expect(members.find((member) => member?.purpose === "chat")).toMatchObject({ micro: 500_000 })
    // The model request's shorter hold did not shorten the set's lifetime.
    expect(Number(await redis(["PTTL", `vector:codium:test:held:${HASH}`]))).toBeGreaterThan(12 * HOUR - 60_000)

    // Eleven minutes on, the model request's hold has lapsed and the 12-hour one has not.
    const later = await holdPool(user.id, 0.25, 60_000, "hosted", { fetcher, now: Date.now() + 700_000 })
    const after = (await heldMembers()).map((member) => parseHoldMember(member)?.ticket)
    expect(after.sort()).toEqual([block.ticket, later.ticket].sort())
    await request.release()
    await block.release()
    await later.release()
    expect(await heldMembers()).toEqual([])
  })

  test("a pool charge cannot spend what a model request holds, nor the other way round", async () => {
    await seed({ price: 10, limit: 6, usage: 1 })
    const block = await holdPool(user.id, 4.9, HOUR, "hosted", { fetcher })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 0.2)).rejects.toMatchObject({
      statusCode: 402,
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await block.release()
    const request = await modelPlanCredential(user.id, fetcher, Date.now(), 0.2)
    await expect(holdPool(user.id, 4.9, HOUR, "hosted", { fetcher })).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await request.release()
  })

  test("two settles racing lose no debit, and a replayed settle records nothing new", async () => {
    await seed({ price: 100, limit: 72 })
    const first = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    const second = await holdPool(user.id, 2, HOUR, "hosted", { fetcher })
    const settled = await Promise.all([first.settle(0.75, "block-a"), second.settle(1.25, "block-b")])
    expect(settled).toEqual([
      { recorded: true, applied: true },
      { recorded: true, applied: true },
    ])
    expect(world.keys.get(HASH)?.limit).toBe(70)
    expect(
      (await readDebits(user.id, HASH, fetcher)).map((debit) => [debit.ref, debit.micro, debit.applied]).sort(),
    ).toEqual([
      ["block-a", 750_000, true],
      ["block-b", 1_250_000, true],
    ])
    expect(await heldMembers()).toEqual([])
    expect((await readModelPlanAccount(user.id, fetcher))?.key?.limitMicro).toBe(70_000_000)

    const again = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    expect(await again.settle(0.75, "block-a")).toEqual({ recorded: false, applied: true })
    expect(world.keys.get(HASH)?.limit).toBe(70)
    expect(await heldMembers()).toEqual([])
    expect(await ledger()).toEqual({ heldMicro: 0, appliedMicro: 2_000_000, pendingMicro: 0 })
  })

  test("a failed PATCH is retried, and the charge stays held, counted once, until it is applied", async () => {
    await seed({ price: 10, limit: 6, usage: 0.5 })
    const block = await holdPool(user.id, 4, HOUR, "hosted", { fetcher })
    world.failPatches = 1
    expect(await block.settle(3.5, "block-1")).toEqual({ recorded: true, applied: false })
    // The key still says 6, but the charge is held, and every figure counts it exactly once.
    expect(world.keys.get(HASH)?.limit).toBe(6)
    const held = await heldMembers()
    expect(held.map((member) => parseHoldMember(member))).toEqual([
      { ticket: block.ticket, purpose: "hosted", run: undefined, micro: 3_500_000 },
    ])
    expect(Number(await redis(["ZSCORE", `vector:codium:test:held:${HASH}`, held[0]!]))).toBeGreaterThan(
      Date.now() + DEBIT_HOLD_MS - 60_000,
    )
    expect(await ledger()).toEqual({ heldMicro: 3_500_000, appliedMicro: 0, pendingMicro: 3_500_000 })
    expect((await status()).monthly).toMatchObject({ credits: 6, used: 4, remaining: 2, available: 2 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 2.1)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })

    // The outbox's debit-apply runs once the retry is due, and nothing changes in what is available.
    expect(await drainDebitApplies({ fetcher })).toEqual({ applied: 0, retried: 0 })
    expect(await drainDebitApplies({ fetcher, now: Date.now() + DEBIT_RETRY_MS + 1_000 })).toEqual({
      applied: 1,
      retried: 0,
    })
    expect(world.keys.get(HASH)?.limit).toBe(2.5)
    expect(await heldMembers()).toEqual([])
    expect(await ledger()).toEqual({ heldMicro: 0, appliedMicro: 3_500_000, pendingMicro: 0 })
    expect((await status()).monthly).toMatchObject({ credits: 6, used: 4, remaining: 2, available: 2 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 2.1)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    expect(await drainDebitApplies({ fetcher, now: Date.now() + DEBIT_RETRY_MS + 1_000 })).toEqual({
      applied: 0,
      retried: 0,
    })
  })

  test("a retry that fails again waits for the next one, and the debit stays held", async () => {
    await seed({ price: 10, limit: 6 })
    const block = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    world.failPatches = 2
    expect(await block.settle(1, "block-1")).toEqual({ recorded: true, applied: false })
    expect(await drainDebitApplies({ fetcher, now: Date.now() + DEBIT_RETRY_MS + 1_000 })).toEqual({
      applied: 0,
      retried: 1,
    })
    expect(await ledger()).toEqual({ heldMicro: 1_000_000, appliedMicro: 0, pendingMicro: 1_000_000 })
    // Any pass under the lease applies it too: here the account's next provisioning.
    await reconcileModelPlanAccount(user.id, fetcher)
    expect(world.keys.get(HASH)?.limit).toBe(5)
    expect(await ledger()).toEqual({ heldMicro: 0, appliedMicro: 1_000_000, pendingMicro: 0 })
    // ...which also took the key off the retry queue.
    expect(await drainDebitApplies({ fetcher, now: Date.now() + 10 * DEBIT_RETRY_MS })).toEqual({
      applied: 0,
      retried: 0,
    })
  })

  test("a debit on a key the account replaced is applied without touching that key", async () => {
    await seed({ price: 10, limit: 6 })
    const old = "hash_replaced"
    await redis([
      "HSET",
      `vector:codium:test:debits:${user.id}:${old}`,
      "block-old",
      JSON.stringify({
        micro: 250_000,
        applied: false,
        hold: "t-old:hosted:-:250000",
        purpose: "hosted",
        at: Date.now(),
      }),
    ])
    await redis(["ZADD", `vector:codium:test:held:${old}`, Date.now() + HOUR, "t-old:hosted:-:250000"])
    expect(await applyPoolDebits(user.id, old, fetcher)).toEqual({ applied: 1, pending: 0 })
    expect(world.openRouter).toEqual([])
    expect(await readDebits(user.id, old, fetcher)).toMatchObject([{ ref: "block-old", applied: true }])
    expect(await redis(["ZRANGE", `vector:codium:test:held:${old}`, 0, -1])).toEqual([])
  })

  test("a pool hold names a known purpose, a valid run and a bounded lifetime", async () => {
    await seed({ price: 100, limit: 72 })
    const refused = [
      holdPool(user.id, 1, 3 * 86_400_000, "hosted", { fetcher }),
      holdPool(user.id, 1, HOUR, "mining" as never, { fetcher }),
      holdPool(user.id, 1, HOUR, "hosted", { fetcher, runId: "a b" }),
      holdPool(user.id, 0, HOUR, "hosted", { fetcher }),
    ]
    for (const hold of refused) await expect(hold).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_INVALID" })
    const block = await holdPool(user.id, 1, HOUR, "hosted", { fetcher })
    await expect(block.settle(-1, "block-1")).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_INVALID" })
    await expect(block.settle(1, "has space")).rejects.toMatchObject({ code: "MODEL_PLAN_POOL_INVALID" })
    await block.release()
    expect(await heldMembers()).toEqual([])
  })
})

// ── M3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("M3: available is the same figure everywhere", () => {
  test("hosted spend lowers status left and refuses a model hold, on the fast path and under the lease alike", async () => {
    await seed({ price: 10, limit: 6, usage: 1 })
    expect((await status()).balance.plan).toMatchObject({ left: 0.83 })
    expect((await status()).monthly).toMatchObject({ shareUsed: 0.17, available: 5 })

    // A running block holds, which does not move the share, but a model request cannot spend it.
    const block = await holdPool(user.id, 3.5, HOUR, "hosted", { fetcher })
    expect((await status()).balance.plan).toMatchObject({ left: 0.83 })
    expect((await status()).monthly).toMatchObject({ available: 1.5 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 2)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })

    // Its charge is spend: the share left drops, and so does what a request may hold.
    expect(await block.settle(3, "block-1")).toEqual({ recorded: true, applied: true })
    expect(world.keys.get(HASH)?.limit).toBe(3)
    const after = await status()
    expect(after.balance.plan).toMatchObject({ left: 0.33 })
    expect(after.monthly).toMatchObject({ credits: 6, used: 4, remaining: 2, available: 2, shareUsed: 0.67 })
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 2.5)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    await (await modelPlanCredential(user.id, fetcher, Date.now(), 1.9)).release()

    // Under the lease (the key's limit had drifted back up), the answer is the same and the key is set right again.
    world.keys.get(HASH)!.limit = 6
    await expect(modelPlanCredential(user.id, fetcher, Date.now(), 2.5)).rejects.toMatchObject({
      code: "MODEL_PLAN_EXHAUSTED",
    })
    expect(world.keys.get(HASH)?.limit).toBe(3)
    world.keys.get(HASH)!.limit = 6
    await (await modelPlanCredential(user.id, fetcher, Date.now(), 1.9)).release()
    expect(world.keys.get(HASH)?.limit).toBe(3)
    expect(await heldMembers()).toEqual([])
  })

  test("a finished request keeps its charge held briefly, and status counts spend, not running requests", async () => {
    await seed({ price: 10, limit: 6, usage: 1 })
    const request = await modelPlanCredential(user.id, fetcher, Date.now(), 0.5)
    expect((await status()).monthly).toMatchObject({ remaining: 5, available: 4.5 })
    // The provider charged 0.2; until the key's usage shows it, it stays held.
    await request.release(0.2)
    expect((await heldMembers()).map((member) => parseHoldMember(member)?.micro)).toEqual([200_000])
    expect((await status()).monthly).toMatchObject({ remaining: 5, available: 4.8 })
  })
})
