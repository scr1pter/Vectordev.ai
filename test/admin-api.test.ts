import { afterEach, describe, expect, test } from "bun:test"
import {
  actionPatch,
  bearerToken,
  fingerprint,
  isOperatorAction,
  isVectorLicensee,
  licenceState,
  listVectorLicences,
  MAX_GRACE_EXTENSION_DAYS,
  requireOperator,
  searchLicences,
  summarise,
  toOperatorLicence,
} from "../api/_lib/admin"
import type { ApiRequest } from "../api/_lib/http"

const NOW = new Date("2026-08-26T12:00:00.000Z")
const TOKEN = "x".repeat(48)

const request = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as ApiRequest

const previous = process.env.VECTOR_ADMIN_TOKEN
afterEach(() => {
  if (previous === undefined) delete process.env.VECTOR_ADMIN_TOKEN
  else process.env.VECTOR_ADMIN_TOKEN = previous
})

describe("operator authentication", () => {
  test("refuses when no operator token is configured", () => {
    delete process.env.VECTOR_ADMIN_TOKEN
    // Falls closed, not open: this endpoint lists every paying customer.
    expect(() => requireOperator(request(`Bearer ${TOKEN}`))).toThrow(/not configured/i)
  })

  test("refuses a token too short to be worth having", () => {
    process.env.VECTOR_ADMIN_TOKEN = "short"
    expect(() => requireOperator(request("Bearer short"))).toThrow(/at least 32/i)
  })

  test("accepts the configured token and rejects anything else", () => {
    process.env.VECTOR_ADMIN_TOKEN = TOKEN
    expect(() => requireOperator(request(`Bearer ${TOKEN}`))).not.toThrow()
    expect(() => requireOperator(request(`Bearer ${"y".repeat(48)}`))).toThrow(/not authorised/i)
    expect(() => requireOperator(request())).toThrow(/not authorised/i)
  })

  test("a prefix of the real token is not enough", () => {
    process.env.VECTOR_ADMIN_TOKEN = TOKEN
    expect(() => requireOperator(request(`Bearer ${TOKEN.slice(0, 40)}`))).toThrow(/not authorised/i)
  })

  test("the token is read from the header only", () => {
    // Never from the query string: that lands in access logs, browser history
    // and Referer headers, which is how operator credentials leak.
    expect(bearerToken("Bearer abc")).toBe("abc")
    expect(bearerToken("bearer   abc  ")).toBe("abc")
    expect(bearerToken("Basic abc")).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
  })
})

describe("what an operator is shown", () => {
  const customer = {
    id: "cus_1",
    email: "buyer@example.com",
    created: 1_756_000_000,
    metadata: {
      vector_email: "buyer@example.com",
      vector_subscription_status: "active",
      vector_license_hash: "abc",
      vector_device_hash: "a".repeat(64),
      vector_device_name: "Krishna's MacBook",
      vector_device_platform: "darwin",
      vector_transfer_count: "2",
      vector_license_last: "9F2K",
    },
  }

  test("device hashes are truncated, never listed in full", () => {
    // The full hash identifies one physical machine. An operator console is for
    // answering support questions, not for collecting a copy of that.
    const licence = toOperatorLicence(customer, NOW)
    expect(licence.deviceFingerprint).toBe("aaaaaaaa…aaaa")
    expect(JSON.stringify(licence)).not.toContain("a".repeat(64))
  })

  test("the licence key itself is never included", () => {
    const licence = toOperatorLicence(customer, NOW)
    expect(JSON.stringify(licence)).not.toContain("abc")
    expect(licence.licenceLast).toBe("9F2K")
  })

  test("fingerprints of an unactivated licence stay undefined", () => {
    expect(fingerprint(undefined)).toBeUndefined()
  })

  test("only Vector's own customers appear", () => {
    expect(isVectorLicensee(customer)).toBe(true)
    expect(isVectorLicensee({ metadata: { some_other_product: "1" } })).toBe(false)
    expect(isVectorLicensee({})).toBe(false)
  })
})

describe("licence state", () => {
  const base = { subscriptionStatus: "active", revokedAt: undefined, cancelAtPeriodEnd: false, graceEndsAt: undefined }

  test("active, and canceling when it will not renew", () => {
    expect(licenceState({ ...base, now: NOW })).toBe("active")
    expect(licenceState({ ...base, cancelAtPeriodEnd: true, now: NOW })).toBe("canceling")
  })

  test("past due within its grace window reads as grace", () => {
    expect(
      licenceState({ ...base, subscriptionStatus: "past_due", graceEndsAt: "2026-08-30T00:00:00.000Z", now: NOW }),
    ).toBe("grace")
  })

  test("past due with an expired grace window reads as past due", () => {
    expect(
      licenceState({ ...base, subscriptionStatus: "past_due", graceEndsAt: "2026-08-01T00:00:00.000Z", now: NOW }),
    ).toBe("past_due")
  })

  test("revocation outranks whatever Stripe says", () => {
    // An operator revoking a licence must not keep reading as active while the
    // subscription winds down.
    expect(licenceState({ ...base, revokedAt: "2026-08-20T00:00:00.000Z", now: NOW })).toBe("revoked")
  })

  test("an unknown subscription status is treated as expired, not active", () => {
    expect(licenceState({ ...base, subscriptionStatus: undefined, now: NOW })).toBe("expired")
    expect(licenceState({ ...base, subscriptionStatus: "incomplete_expired", now: NOW })).toBe("expired")
  })
})

describe("operator actions", () => {
  test("releasing a device also clears the transfer window", () => {
    // Otherwise a customer who already used their moves this month is blocked
    // again by the very limit that sent them to support.
    const patch = actionPatch({ action: "release-device", now: NOW })
    expect(patch.vector_device_hash).toBe("")
    expect(patch.vector_transfer_count).toBe("")
    expect(patch.vector_transfer_window_started_at).toBe("")
    expect(patch.vector_deactivated_at).toBe(NOW.toISOString())
  })

  test("revoking clears the activation so the machine stops validating", () => {
    const patch = actionPatch({ action: "revoke", now: NOW })
    expect(patch.vector_revoked_at).toBe(NOW.toISOString())
    expect(patch.vector_activation_hash).toBe("")
    expect(patch.vector_device_hash).toBe("")
  })

  test("restoring clears only the revocation", () => {
    expect(actionPatch({ action: "restore", now: NOW })).toEqual({ vector_revoked_at: "" })
  })

  test("grace extension is bounded and defaults to a week", () => {
    const week = actionPatch({ action: "extend-grace", now: NOW })
    expect(week.vector_payment_grace_ends_at).toBe("2026-09-02T12:00:00.000Z")
    const capped = actionPatch({ action: "extend-grace", now: NOW, days: 4_000 })
    const days = (Date.parse(capped.vector_payment_grace_ends_at) - NOW.getTime()) / 86_400_000
    expect(days).toBe(MAX_GRACE_EXTENSION_DAYS)
    const floored = actionPatch({ action: "extend-grace", now: NOW, days: -5 })
    expect(Date.parse(floored.vector_payment_grace_ends_at)).toBeGreaterThan(NOW.getTime())
  })

  test("only the four known actions are accepted", () => {
    expect(isOperatorAction("revoke")).toBe(true)
    expect(isOperatorAction("delete-customer")).toBe(false)
    expect(isOperatorAction(undefined)).toBe(false)
  })
})

describe("counting and finding licences", () => {
  const licences = [
    toOperatorLicence({ id: "c1", metadata: { vector_license_hash: "1", vector_subscription_status: "active", vector_email: "a@x.com", vector_device_hash: "b".repeat(64) } }, NOW),
    toOperatorLicence({ id: "c2", metadata: { vector_license_hash: "2", vector_subscription_status: "active", vector_email: "b@x.com" } }, NOW),
    toOperatorLicence({ id: "c3", metadata: { vector_license_hash: "3", vector_subscription_status: "canceled", vector_email: "c@x.com" } }, NOW),
    toOperatorLicence({ id: "c4", metadata: { vector_license_hash: "4", vector_subscription_status: "active", vector_email: "d@x.com", vector_revoked_at: "2026-08-01T00:00:00.000Z" } }, NOW),
  ]

  test("the summary is the answer to how many users there are", () => {
    expect(summarise(licences)).toEqual({
      total: 4,
      active: 2,
      canceling: 0,
      grace: 0,
      pastDue: 0,
      expired: 1,
      revoked: 1,
      activated: 1,
      neverActivated: 3,
    })
  })

  test("search covers email, customer id and device name", () => {
    expect(searchLicences(licences, "b@x").map((l) => l.customerId)).toEqual(["c2"])
    expect(searchLicences(licences, "c3").map((l) => l.customerId)).toEqual(["c3"])
    expect(searchLicences(licences, "").length).toBe(4)
  })
})

describe("listing every licensee", () => {
  test("pages through Stripe and skips non-Vector customers", async () => {
    const pages = [
      { data: [{ id: "c1", metadata: { vector_license_hash: "1" } }, { id: "other", metadata: {} }], has_more: true },
      { data: [{ id: "c2", metadata: { vector_subscription_id: "sub_2" } }], has_more: false },
    ]
    let call = 0
    const stripe = { customers: { list: async () => pages[call++] } } as never
    const licences = await listVectorLicences(stripe)
    expect(licences.map((l) => l.customerId)).toEqual(["c1", "c2"])
  })

  test("a page that reports more but returns nothing does not loop forever", async () => {
    const stripe = { customers: { list: async () => ({ data: [], has_more: true }) } } as never
    expect((await listVectorLicences(stripe)).length).toBe(0)
  })
})
