import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { checkoutConsentFields, CODIUM_TERMS_DATE } from "../api/_lib/codium-consent"
import { placeHold, recordDebit } from "../api/_lib/codium-pool"
import { codiumKey } from "../api/_lib/codium-keys"
import { carryMicro, releaseDowngrade } from "../api/_lib/codium-plan-change"
import { drainOutbox } from "../api/_lib/codium-provision"
import {
  applyPoolDebits,
  modelPlanChange,
  modelPlanCredential,
  modelPlanPortal,
  readModelPlanAccount,
  reconcileModelPlanAccount,
} from "../api/_lib/model-plan-account"
import {
  codiumFakes,
  codiumTestEnvironment,
  FIXTURE_CREDITS,
  loadStripeFixture,
  type CodiumFakes,
} from "../packages/web/test/fixture/codium-fakes"

let restore = () => {}
beforeEach(() => {
  restore = codiumTestEnvironment({
    STRIPE_MODEL_PLAN_PORTAL_CONFIG_ID: "bpc_fixture",
    VECTOR_ADMIN_EMAILS: "subscriber@example.invalid",
  })
})
afterEach(() => restore())
const fixture = loadStripeFixture("active-paid")
const id = fixture.accountId
const user = { id, email: "subscriber@example.invalid" }
const now = fixture.now * 1000
const accountKey = codiumKey("account", id)

function seed() {
  const fakes = codiumFakes({ now })
  fakes.stripe.load(fixture.objects)
  fakes.store.set(accountKey, JSON.stringify(fixture.account))
  return fakes
}

/** A separately paid full month, as subscription-mode Checkout creates for an upgrade. */
function paidUpgrade(
  fakes: CodiumFakes,
  amount: 50 | 100 | 200 = 50,
  subscriptionID = "sub_upgrade",
  supersedes = "sub_active",
) {
  const source = fakes.stripe.subscription("sub_active")!
  const invoice = structuredClone(fixture.objects.invoices![0]!)
  const charge = structuredClone(fixture.objects.charges![0]!)
  const subscription = structuredClone(source)
  const start = fixture.now
  const end = start + 30 * 86400
  const price = {
    id: `price_codium${amount}`,
    active: true,
    currency: "usd",
    unit_amount: amount * 100,
    recurring: { interval: "month", interval_count: 1 },
  }
  Object.assign(subscription, {
    id: subscriptionID,
    status: "active",
    cancel_at_period_end: false,
    current_period_start: start,
    current_period_end: end,
    latest_invoice: `in_${subscriptionID}`,
    schedule: null,
    metadata: {
      vector_account_id: id,
      vector_plan: `vector-${amount}`,
      vector_model_credits_usd: FIXTURE_CREDITS[amount],
      vector_supersedes: supersedes,
    },
    items: { data: [{ id: "si_upgrade", price, quantity: 1 }] },
  })
  Object.assign(invoice, {
    id: `in_${subscriptionID}`,
    subscription: subscriptionID,
    charge: `ch_${subscriptionID}`,
    amount_paid: amount * 100,
    lines: { data: [{ price, proration: false, period: { start, end } }] },
  })
  Object.assign(charge, {
    id: `ch_${subscriptionID}`,
    invoice: `in_${subscriptionID}`,
    amount: amount * 100,
    payment_method_details: { card: { three_d_secure: { result: "authenticated" } } },
  })
  fakes.stripe.load({ subscriptions: [subscription], invoices: [invoice], charges: [charge] })
}

async function active(fakes: CodiumFakes) {
  await reconcileModelPlanAccount(id, fakes.fetcher, now)
  return (await readModelPlanAccount(id, fakes.fetcher))!.key!
}

function funded(fakes: CodiumFakes) {
  fakes.store.set(
    codiumKey("funding"),
    JSON.stringify({ status: "open", checkedAt: now, since: now, balance: 1_000_000, owed: 0, required: 0, keys: 0 }),
  )
  // Funding's atomic reservation script must be exercised by its own tests; here check what /change reserves.
  const script =
    "local reserved = 0 local entries = redis.call('HGETALL', KEYS[1]) for i = 1, #entries, 2 do local lapses, cents = string.match(entries[i + 1], '^(%d+):(%d+)$') if not lapses or tonumber(lapses) <= tonumber(ARGV[1]) or entries[i] == ARGV[3] then redis.call('HDEL', KEYS[1], entries[i]) elseif entries[i] ~= ARGV[2] then reserved = reserved + tonumber(cents) end end if tonumber(ARGV[6]) < math.ceil((tonumber(ARGV[7]) + reserved + tonumber(ARGV[4])) * (100 + tonumber(ARGV[8])) / 100) + tonumber(ARGV[9]) then return 0 end redis.call('HSET', KEYS[1], ARGV[2], ARGV[5] .. ':' .. ARGV[4]) return 1"
  fakes.store.scripts.set(script, ([key], args) => {
    fakes.store.hash(key!).set(args[1]!, `${args[4]}:${args[3]}`)
    return 1
  })
}

describe("Codium plan change", () => {
  test("carry subtracts spend and reservations, clamps exhausted periods, and refuses unreadable amounts", () => {
    expect(carryMicro(4_000_000, 250_000, 1_000_000)).toBe(2_750_000)
    expect(carryMicro(10, 20)).toBe(0)
    expect(() => carryMicro(10, NaN)).toThrow()
  })

  test("paid upgrade carries once, starts new meters, cancels once, and clears collectible invoices", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    fakes.store.zset(codiumKey("held", old.hash)).set("ticket:chat:-:1000000", now + 600_000)
    fakes.stripe.load({
      invoices: [
        { id: "in_oldopen", customer: fixture.account.customer, subscription: "sub_active", status: "open" },
        { id: "in_olddraft", customer: fixture.account.customer, subscription: "sub_active", status: "draft" },
      ],
    })
    paidUpgrade(fakes)
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const account = (await readModelPlanAccount(id, fakes.fetcher))!
    expect(account.key!.carry).toMatchObject({
      micro: 2_750_000,
      fromSubscription: "sub_active",
      fromCharge: "ch_active",
    })
    expect(fakes.openRouter.keys.get(old.hash)!.disabled).toBe(true)
    expect(fakes.openRouter.keys.get(account.key!.hash)!.limit).toBe(24.75)
    expect(snapshot.meterEpoch).toBe(`sub_upgrade:${fixture.now * 1000}`)
    expect(fakes.stripe.subscription("sub_active")!.status).toBe("canceled")
    expect(fakes.stripe.objects.invoices.get("in_oldopen")!.status).toBe("void")
    expect(fakes.stripe.objects.invoices.has("in_olddraft")).toBe(false)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(2_750_000)
    expect(
      fakes.stripe.calls.filter((call) => call.method === "DELETE" && call.path === "subscriptions/sub_active"),
    ).toHaveLength(1)
    expect(fakes.openRouter.calls.filter((call) => call.method === "POST")).toHaveLength(2)
  })

  test("delayed true-up raises only, ignores the replaced key, and removes carry when its source is reversed", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    fakes.store.zset(codiumKey("held", old.hash)).set("ticket:chat:-:1000000", now + 600_000)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    fakes.clock.advance(12 * 60_000)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.5
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_500_000)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(25.5)
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    await reconcileModelPlanAccount(id, fakes.fetcher, fakes.clock.now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(0)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(22)
  })

  test("late hosted debits on a replaced key stay spent after true-up", async () => {
    const fakes = seed()
    const old = await active(fakes)
    const hold = await placeHold(
      {
        account: id,
        pool: old.hash,
        baseMicro: 4_000_000,
        requiredMicro: 1_000_000,
        ttlMs: 60_000,
        purpose: "hosted",
        now,
      },
      fakes.fetcher,
    )
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_000_000)
    await recordDebit(hold!, { ref: "hosted:late", micro: 1_000_000, now, keepUntil: now + 86400_000 }, fakes.fetcher)
    await applyPoolDebits(id, old.hash, fakes.fetcher)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_000_000)
  })

  test("repeated upgrades retain payment ancestry, and a source refund cannot be hidden by another upgrade", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    paidUpgrade(fakes, 100, "sub_second", "sub_upgrade")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const current = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(current.carry!.micro).toBe(25_750_000)
    expect(current.carry!.origins).toEqual([
      { charge: "ch_sub_upgrade", micro: 22_000_000 },
      { charge: "ch_active", micro: 3_750_000 },
    ])
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(22_000_000)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(22_000_000)
    expect(fakes.openRouter.keys.get(current.hash)!.limit).toBe(70)
  })

  test("true-up cannot resurrect an older allowance consumed before an intermediate source was refunded", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const middle = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    fakes.openRouter.keys.get(middle.hash)!.usage = 10
    paidUpgrade(fakes, 100, "sub_second", "sub_upgrade")
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.origins).toEqual([
      { charge: "ch_sub_upgrade", micro: 16_000_000 },
    ])
    Object.assign(fakes.stripe.charge("ch_sub_upgrade")!, { refunded: true, amount_refunded: 5000 })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(0)
  })

  test("a source reversal after interrupted key creation is removed before the replacement can serve", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    fakes.openRouter.fail = (call) =>
      call.method === "POST" ? new Response("unavailable", { status: 503 }) : undefined
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    fakes.openRouter.fail = undefined
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(key.carry!.micro).toBe(0)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(22)
    const attempts = fakes.openRouter.calls.filter(
      (call) => call.method === "POST" && call.json?.name !== fakes.openRouter.keys.get("fake_key_1")?.name,
    )
    expect(attempts.map((call) => call.json!.limit)).toEqual([26, 26])
  })

  test("a source refund discovered by the true-up itself lowers the stored and provider limits", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(key.carry!.micro).toBe(0)
    expect(key.limitMicro).toBe(22_000_000)
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(22)
  })

  test("concurrent model admission waits until a replacement's carry is validated", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    let resume = () => {}
    let entered = () => {}
    let attempted = () => {}
    let waiting = false
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    const lease = new Promise<void>((resolve) => {
      attempted = resolve
    })
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input)
      if (url.includes("charges/ch_active") && !waiting && JSON.parse(fakes.store.get(accountKey)!).key?.provisioning) {
        waiting = true
        entered()
        await gate
      }
      if (waiting && typeof init?.body === "string") {
        const body = JSON.parse(init.body)
        if (Array.isArray(body) && body[0] === "SET" && body[1] === codiumKey("lease", id) && body.includes("NX"))
          attempted()
      }
      return fakes.fetcher(input, init)
    }
    const reconcile = reconcileModelPlanAccount(id, fetcher, now)
    await paused
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    const admission = modelPlanCredential(id, fetcher, now, 25).then(
      () => "admitted",
      () => "refused",
    )
    try {
      expect(await Promise.race([lease.then(() => "lease"), admission])).toBe("lease")
    } finally {
      resume()
    }
    await reconcile
    expect(await admission).toBe("refused")
  })

  test("combined base and carry respect the test-mode key cap", async () => {
    process.env.CODIUM_TEST_CREDIT_CAP_USD = "0.50"
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const key = (await readModelPlanAccount(id, fakes.fetcher))!.key!
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(0.5)
    fakes.clock.advance(12 * 60_000)
    await drainOutbox({ now: fakes.clock.now, fetcher: fakes.fetcher })
    expect(fakes.openRouter.keys.get(key.hash)!.limit).toBe(0.5)
  })

  test("key creation retry keeps the original carry and never creates a second funded replacement", async () => {
    const fakes = seed()
    const old = await active(fakes)
    fakes.openRouter.keys.get(old.hash)!.usage = 0.25
    paidUpgrade(fakes)
    let failed = false
    fakes.openRouter.fail = (call) => {
      if (call.method === "POST" && !failed) {
        failed = true
        return new Response("unavailable", { status: 503 })
      }
    }
    await expect(reconcileModelPlanAccount(id, fakes.fetcher, now)).rejects.toMatchObject({
      code: "MODEL_PLAN_UPSTREAM",
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.upgrade!.micro).toBe(3_750_000)
    fakes.openRouter.fail = undefined
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry!.micro).toBe(3_750_000)
    expect(fakes.openRouter.keys.size).toBe(2)
  })

  test("an unpaid or reversed source contributes no carry", async () => {
    const fakes = seed()
    await active(fakes)
    Object.assign(fakes.stripe.charge("ch_active")!, { refunded: true, amount_refunded: 1000 })
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.key!.carry).toBeUndefined()
  })

  test("upgrade refuses paused, scheduled and risk-blocked accounts before opening checkout", async () => {
    for (const situation of ["past_due", "scheduled", "blocked"]) {
      const fakes = seed()
      await active(fakes)
      if (situation === "past_due") fakes.stripe.subscription("sub_active")!.status = "past_due"
      if (situation === "scheduled") {
        fakes.stripe.subscription("sub_active")!.schedule = "sub_schedforeign"
        fakes.stripe.load({
          subscription_schedules: [
            {
              id: "sub_schedforeign",
              customer: fixture.account.customer,
              subscription: "sub_active",
              status: "active",
              phases: [],
            },
          ],
        })
      }
      if (situation === "blocked")
        fakes.store.set(
          accountKey,
          JSON.stringify({
            ...(await readModelPlanAccount(id, fakes.fetcher)),
            risk: { blocked: true, reason: "owner", openDisputes: {}, efw: [] },
          }),
        )
      await expect(modelPlanChange(user, "vector-50", fakes.fetcher, now)).rejects.toMatchObject({
        code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
      })
      expect(fakes.stripe.calls.some((call) => call.method === "POST" && call.path === "checkout/sessions")).toBe(false)
    }
  })

  test("upgrade reserves its sale, binds supersedes on the server, collects consent and preserves old-client returns", async () => {
    const fakes = seed()
    await active(fakes)
    funded(fakes)
    expect(await modelPlanChange(user, "vector-50", fakes.fetcher, now)).toEqual({
      url: "https://checkout.stripe.com/c/fixture",
    })
    const checkout = fakes.stripe.calls.find((call) => call.method === "POST" && call.path === "checkout/sessions")!
    expect(checkout.form!.get("subscription_data[metadata][vector_supersedes]")).toBe("sub_active")
    expect(checkout.form!.get("success_url")).toBe("https://vectordev.ai/account?model_plan=success&change=upgrade")
    expect(checkout.form!.get("consent_collection[terms_of_service]")).toBe("required")
    expect(fakes.store.hash(codiumKey("funding", "reserved")).size).toBe(1)
    await modelPlanChange(user, "vector-50", fakes.fetcher, now)
    expect(
      fakes.stripe.calls.filter((call) => call.method === "POST" && call.path === "checkout/sessions"),
    ).toHaveLength(1)
  })

  test("downgrade bills the current price until renewal, then releases to the lower price; cancellation releases first", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(await modelPlanChange(user, "vector-10", fakes.fetcher, now)).toMatchObject({
      scheduled: { plan: "vector-10" },
    })
    const schedule = fakes.stripe.calls.find(
      (call) => call.method === "POST" && call.path.startsWith("subscription_schedules/"),
    )!
    expect(schedule.form!.get("end_behavior")).toBe("release")
    expect(schedule.form!.get("phases[0][items][0][price]")).toBe("price_codium50")
    expect(schedule.form!.get("phases[1][items][0][price]")).toBe("price_codium10")
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot.scheduled?.plan).toBe("vector-10")
    await modelPlanPortal(id, fakes.fetcher, { flow: "cancel", now })
    const release = fakes.stripe.calls.findIndex((call) => call.path.endsWith("/release"))
    const portal = fakes.stripe.calls.findIndex((call) => call.path === "billing_portal/sessions")
    expect(release).toBeGreaterThan(-1)
    expect(portal).toBeGreaterThan(release)
    expect(fakes.stripe.subscription("sub_upgrade")!.schedule).toBeNull()
  })

  test("item-level Stripe periods drive both schedule creation and its entitlement snapshot", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    const subscription = fakes.stripe.subscription("sub_upgrade")!
    const item = (subscription.items as { data: Record<string, unknown>[] }).data[0]!
    item.current_period_start = subscription.current_period_start
    item.current_period_end = subscription.current_period_end
    delete subscription.current_period_start
    delete subscription.current_period_end
    await modelPlanChange(user, "vector-10", fakes.fetcher, now)
    const snapshot = await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect(snapshot.scheduled).toEqual({ plan: "vector-10", at: Number(item.current_period_end) * 1000 })
  })

  test("DELETE releases a scheduled downgrade without sales funding, and foreign schedules fail closed", async () => {
    const fakes = seed()
    await active(fakes)
    fakes.stripe.subscription("sub_active")!.schedule = "sub_sched1"
    fakes.stripe.load({
      subscription_schedules: [
        {
          id: "sub_sched1",
          customer: fixture.account.customer,
          subscription: "sub_active",
          status: "active",
          phases: [],
        },
      ],
    })
    expect(await modelPlanChange(user, undefined, fakes.fetcher, now)).toEqual({ scheduled: false })
    fakes.stripe.subscription("sub_active")!.schedule = "sub_foreign"
    fakes.stripe.load({
      subscription_schedules: [
        { id: "sub_foreign", customer: "cus_elsewhere", subscription: "sub_elsewhere", status: "active" },
      ],
    })
    await expect(releaseDowngrade(fakes.stripe.subscription("sub_active")!, fakes.fetcher)).rejects.toMatchObject({
      code: "MODEL_PLAN_CHANGE_UNAVAILABLE",
    })
  })

  test("an interrupted downgrade followed by portal cancellation can be scheduled again", async () => {
    const fakes = seed()
    await active(fakes)
    paidUpgrade(fakes)
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    fakes.stripe.fail = (call) =>
      call.method === "POST" && /^subscription_schedules\/[^/]+$/.test(call.path)
        ? new Response("unavailable", { status: 503 })
        : undefined
    await expect(modelPlanChange(user, "vector-10", fakes.fetcher, now)).rejects.toMatchObject({
      code: "BILLING_UPSTREAM",
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.downgrade).toBeDefined()
    fakes.stripe.fail = undefined
    await modelPlanPortal(id, fakes.fetcher, { flow: "cancel", now })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.downgrade).toBeUndefined()
    expect(await modelPlanChange(user, "vector-10", fakes.fetcher, now)).toMatchObject({
      scheduled: { plan: "vector-10" },
    })
    expect(fakes.stripe.objects.subscription_schedules.size).toBe(2)
  })

  test("consent comes from the completed checkout and confirmation is sent once, without trusting return URLs", async () => {
    const fakes = seed()
    await active(fakes)
    fakes.store.set(
      accountKey,
      JSON.stringify({
        ...(await readModelPlanAccount(id, fakes.fetcher)),
        checkout: {
          id: "cs_paid",
          plan: "vector-10",
          url: "https://checkout.stripe.com/c/fixture",
          expires: now + 3600_000,
        },
      }),
    )
    fakes.stripe.load({
      checkout_sessions: [
        {
          id: "cs_paid",
          customer: fixture.account.customer,
          status: "complete",
          payment_status: "paid",
          consent: { terms_of_service: "accepted" },
          metadata: { vector_terms_date: CODIUM_TERMS_DATE },
        },
      ],
    })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    expect((await readModelPlanAccount(id, fakes.fetcher))!.consent).toMatchObject({
      session: "cs_paid",
      terms_of_service: "accepted",
      terms_date: CODIUM_TERMS_DATE,
    })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.consent!.confirmationSent).toBeUndefined()
    process.env.RESEND_API_KEY = "fixture-email-key"
    process.env.VECTOR_PURCHASE_EMAIL_FROM = "Vector <receipts@example.invalid>"
    fakes.stripe.objects.customers.get(String(fixture.account.customer))!.email = user.email
    await drainOutbox({ now: Date.now(), fetcher: fakes.fetcher })
    await reconcileModelPlanAccount(id, fakes.fetcher, now)
    await drainOutbox({ now: Date.now(), fetcher: fakes.fetcher })
    expect((await readModelPlanAccount(id, fakes.fetcher))!.consent!.confirmationSent).toBe(true)
    expect(fakes.mail.sent).toHaveLength(1)
  })

  test("legacy portal plan-change flow always returns the account link and ignores the obsolete change configuration", async () => {
    const fakes = seed()
    process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID = "bpc_unsafe"
    await expect(modelPlanPortal(id, fakes.fetcher, { flow: "change" })).rejects.toMatchObject({
      statusCode: 409,
      message: "Change plans on vectordev.ai/account.",
    })
    await modelPlanPortal(id, fakes.fetcher)
    expect(fakes.stripe.calls.find((call) => call.path === "billing_portal/sessions")!.form!.get("configuration")).toBe(
      "bpc_fixture",
    )
    delete process.env.STRIPE_MODEL_PLAN_CHANGE_PORTAL_CONFIG_ID
  })

  test("consent quotes the actual monthly price, dates it, and enables tax only behind its switch", () => {
    expect(checkoutConsentFields({ id: "vector-100", price: 100 })).toMatchObject({
      "metadata[vector_terms_date]": CODIUM_TERMS_DATE,
    })
    expect(
      checkoutConsentFields({ id: "vector-100", price: 100 })["custom_text[terms_of_service_acceptance][message]"],
    ).toContain("Renews monthly at $100")
    expect(
      checkoutConsentFields({ id: "vector-100", price: 100 })["custom_text[terms_of_service_acceptance][message]"],
    ).toContain("not part of this purchase")
    expect(checkoutConsentFields({ id: "vector-10", price: 10 })).not.toHaveProperty("automatic_tax[enabled]")
    process.env.CODIUM_STRIPE_AUTOMATIC_TAX = "true"
    expect(checkoutConsentFields({ id: "vector-10", price: 10 })["automatic_tax[enabled]"]).toBe("true")
    delete process.env.CODIUM_STRIPE_AUTOMATIC_TAX
  })
})
