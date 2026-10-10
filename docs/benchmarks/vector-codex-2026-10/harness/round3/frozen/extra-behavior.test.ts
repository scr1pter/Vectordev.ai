import { expect, test } from "bun:test"
import { join } from "node:path"

const fixture = process.env.VECTOR_BENCH_FIXTURE
const task = process.env.VECTOR_BENCH_TASK
if (!fixture || !task) throw new Error("Run through validate-extra.ts")

if (task === "bugfix-idempotent-webhooks") {
  type Event =
    | { id: string; created: number; type: "invoice.paid"; credits: number }
    | { id: string; created: number; type: "subscription.updated"; active: boolean }
  type State = { active: boolean; credits: number; lastSubscriptionEventAt: number; processedEventIds: string[] }
  const implementation: {
    emptyEntitlement(): State
    applyBillingEvent(state: State, event: Event): State
  } = await import(join(fixture, "src/entitlements.ts"))

  test("an exact subscription retry has no effect", () => {
    const event = { id: "subscription-1", created: 100, type: "subscription.updated" as const, active: true }
    const once = implementation.applyBillingEvent(implementation.emptyEntitlement(), event)
    expect(implementation.applyBillingEvent(once, event)).toEqual(once)
  })

  test("a subscription replay cannot restore state after a newer update", () => {
    const event = { id: "subscription-on", created: 100, type: "subscription.updated" as const, active: true }
    const first = implementation.applyBillingEvent(implementation.emptyEntitlement(), event)
    const newer = implementation.applyBillingEvent(first, {
      id: "subscription-off", created: 300, type: "subscription.updated", active: false,
    })
    expect(implementation.applyBillingEvent(newer, event)).toEqual(newer)
  })

  test("a stale subscription event is recorded once and never rolls back state", () => {
    const newer = implementation.applyBillingEvent(implementation.emptyEntitlement(), {
      id: "newest", created: 500, type: "subscription.updated", active: true,
    })
    const stale = { id: "stale", created: 20, type: "subscription.updated" as const, active: false }
    const once = implementation.applyBillingEvent(newer, stale)
    expect(once).toEqual({ ...newer, processedEventIds: ["newest", "stale"] })
    expect(implementation.applyBillingEvent(once, stale)).toEqual(once)
  })

  test("distinct old invoices both grant credits and subsequent retries do not", () => {
    const current = implementation.applyBillingEvent(implementation.emptyEntitlement(), {
      id: "sub", created: 500, type: "subscription.updated", active: true,
    })
    const first = { id: "invoice-a", created: 10, type: "invoice.paid" as const, credits: 17 }
    const second = { id: "invoice-b", created: 10, type: "invoice.paid" as const, credits: 29 }
    const once = implementation.applyBillingEvent(implementation.applyBillingEvent(current, first), second)
    expect(once).toEqual({
      active: true, credits: 46, lastSubscriptionEventAt: 500,
      processedEventIds: ["sub", "invoice-a", "invoice-b"],
    })
    expect(implementation.applyBillingEvent(implementation.applyBillingEvent(once, second), first)).toEqual(once)
  })
}

if (task === "feature-retry-schedule") {
  const implementation: {
    retrySchedule(attempts: number, options?: { baseMs?: number; factor?: number; maxMs?: number; budgetMs?: number }): number[]
  } = await import(join(fixture, "src/backoff.ts"))

  test("budgets stop before the next delay would exceed the cumulative allowance", () => {
    expect(implementation.retrySchedule(6, { budgetMs: 0 })).toEqual([])
    expect(implementation.retrySchedule(6, { budgetMs: 99 })).toEqual([])
    expect(implementation.retrySchedule(6, { budgetMs: 100 })).toEqual([100])
    expect(implementation.retrySchedule(6, { budgetMs: 299 })).toEqual([100])
    expect(implementation.retrySchedule(6, { budgetMs: 300 })).toEqual([100, 200])
    expect(implementation.retrySchedule(6, { budgetMs: 699 })).toEqual([100, 200])
    expect(implementation.retrySchedule(6, { budgetMs: 700 })).toEqual([100, 200, 400])
  })

  test("the maxMs cap applies to every scheduled delay", () => {
    expect(implementation.retrySchedule(5, { maxMs: 250 })).toEqual([100, 200, 250, 250, 250])
    expect(implementation.retrySchedule(3, { baseMs: 90, factor: 3, maxMs: 80 })).toEqual([80, 80, 80])
  })

  test("the budget counts capped delays", () => {
    expect(implementation.retrySchedule(5, { maxMs: 250, budgetMs: 550 })).toEqual([100, 200, 250])
    expect(implementation.retrySchedule(5, { maxMs: 250, budgetMs: 549 })).toEqual([100, 200])
  })

  test("attempt count wins when the remaining budget is large", () => {
    expect(implementation.retrySchedule(1, { budgetMs: 1_000_000 })).toEqual([100])
    expect(implementation.retrySchedule(0, { budgetMs: 1_000_000 })).toEqual([])
    expect(implementation.retrySchedule(4, { baseMs: 7, factor: 1 })).toEqual([7, 7, 7, 7])
  })
}

if (task === "refactor-structured-logging") {
  const modules = [
    { pkg: "billing", file: "invoices", fn: "createInvoice", message: "invoice created", field: "invoiceId" },
    { pkg: "billing", file: "refunds", fn: "issueRefund", message: "refund issued", field: "refundId" },
    { pkg: "billing", file: "plans", fn: "changePlan", message: "plan changed", field: "planId" },
    { pkg: "billing", file: "coupons", fn: "applyCoupon", message: "coupon applied", field: "couponCode" },
    { pkg: "accounts", file: "signup", fn: "registerAccount", message: "account registered", field: "accountId" },
    { pkg: "accounts", file: "login", fn: "recordLogin", message: "login recorded", field: "sessionId" },
    { pkg: "accounts", file: "roles", fn: "grantRole", message: "role granted", field: "roleName" },
    { pkg: "accounts", file: "closure", fn: "closeAccount", message: "account closed", field: "accountId" },
    { pkg: "notify", file: "email", fn: "queueEmail", message: "email queued", field: "templateId" },
    { pkg: "notify", file: "sms", fn: "queueSms", message: "sms queued", field: "phoneHash" },
    { pkg: "notify", file: "push", fn: "queuePush", message: "push queued", field: "deviceId" },
    { pkg: "notify", file: "digest", fn: "scheduleDigest", message: "digest scheduled", field: "digestDay" },
  ]
  const shared: { entries: string[] } = await import(join(fixture, "packages/shared/src/log.ts"))
  const implementations: Record<string, (value: string) => Record<string, unknown>>[] = await Promise.all(
    modules.map((item) => import(join(fixture, `packages/${item.pkg}/src/${item.file}.ts`))),
  )

  test("all modules preserve empty and escaped strings across repeated calls", () => {
    shared.entries.length = 0
    modules.forEach((item, index) => {
      expect(implementations[index]![item.fn]!("")).toEqual({ [item.field]: "", ok: true })
      expect(implementations[index]![item.fn]!(`value-${index}: \"quoted\"\nnext`)).toEqual({
        [item.field]: `value-${index}: \"quoted\"\nnext`, ok: true,
      })
    })
    expect(shared.entries).toEqual(modules.flatMap((item, index) => [
      `${item.pkg}: ${item.message} ${JSON.stringify({ [item.field]: "" })}`,
      `${item.pkg}: ${item.message} ${JSON.stringify({ [item.field]: `value-${index}: \"quoted\"\nnext` })}`,
    ]))
  })
}
