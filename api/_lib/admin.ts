import { createHash, timingSafeEqual } from "node:crypto"
import type Stripe from "stripe"

import { ApiError, type ApiRequest } from "./http.js"

// Operator-facing licensing. Every endpoint under api/billing acts only on the
// caller's own licence, proved by a signed activation token from their machine.
// This module is the other half: it reads across ALL customers and can revoke,
// so it is authenticated completely differently and returns a deliberately
// reduced projection of each record.
//
// Two rules hold everything here together:
//   1. Fail closed. With no operator token configured the endpoints refuse
//      rather than fall open, because falling open exposes every customer.
//   2. Never widen what billing already exposes. The licence key is derived
//      from an HMAC and is never listed; device hashes are truncated. An
//      operator console is a place to answer support questions, not a place to
//      collect a copy of the customer database.

const MINIMUM_TOKEN_LENGTH = 32

export type OperatorLicenceState = "active" | "canceling" | "grace" | "past_due" | "expired" | "revoked"

export type OperatorLicence = {
  customerId: string
  email: string
  state: OperatorLicenceState
  plan: string
  subscriptionStatus: string
  createdAt?: string
  periodEnd?: string
  graceEndsAt?: string
  cancelAtPeriodEnd: boolean
  /** Truncated. The full hash identifies a specific physical machine. */
  deviceFingerprint?: string
  deviceName?: string
  devicePlatform?: string
  activatedAt?: string
  lastSeenAt?: string
  transferCount: number
  downloadCount: number
  /** Last four of the licence key, which is what a customer can read to us. */
  licenceLast?: string
  revokedAt?: string
}

export type LicenceSummary = {
  total: number
  active: number
  canceling: number
  grace: number
  pastDue: number
  expired: number
  revoked: number
  activated: number
  neverActivated: number
}

function operatorToken() {
  const value = process.env.VECTOR_ADMIN_TOKEN?.trim()
  if (!value) {
    throw new ApiError(
      503,
      "ADMIN_NOT_CONFIGURED",
      "Vector's operator console is not configured. Set VECTOR_ADMIN_TOKEN to enable it.",
    )
  }
  if (value.length < MINIMUM_TOKEN_LENGTH) {
    // A short token on an endpoint that lists every customer is worse than no
    // endpoint, so this refuses rather than serving with weak protection.
    throw new ApiError(
      503,
      "ADMIN_NOT_CONFIGURED",
      `VECTOR_ADMIN_TOKEN must be at least ${MINIMUM_TOKEN_LENGTH} characters.`,
    )
  }
  return value
}

export function bearerToken(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match?.[1]?.trim() || undefined
}

function constantTimeEqual(left: string, right: string) {
  // Compare digests, not the raw strings: equal-length digests keep the
  // comparison constant time even when the candidates differ in length.
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

// Deliberately header-only. A token in the query string lands in access logs,
// browser history and Referer headers, which is how operator credentials leak.
export function requireOperator(request: ApiRequest) {
  const expected = operatorToken()
  const presented = bearerToken(request.headers?.authorization)
  if (!presented || !constantTimeEqual(presented, expected)) {
    throw new ApiError(401, "ADMIN_UNAUTHORIZED", "This request is not authorised.")
  }
}

export function fingerprint(hash: string | undefined) {
  if (!hash) return undefined
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`
}

function timestamp(value: string | undefined) {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function count(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function licenceState(input: {
  subscriptionStatus: string | undefined
  revokedAt: string | undefined
  cancelAtPeriodEnd: boolean
  graceEndsAt: string | undefined
  now: Date
}): OperatorLicenceState {
  // Revocation is an operator decision and outranks whatever Stripe says, so a
  // revoked licence never reads as active while the subscription winds down.
  if (input.revokedAt) return "revoked"
  const status = input.subscriptionStatus ?? ""
  if (status === "past_due" || status === "unpaid") {
    const grace = timestamp(input.graceEndsAt)
    if (grace && new Date(grace) > input.now) return "grace"
    return "past_due"
  }
  if (status === "canceled" || status === "incomplete_expired") return "expired"
  if (status === "active" || status === "trialing") return input.cancelAtPeriodEnd ? "canceling" : "active"
  return "expired"
}

export function toOperatorLicence(
  customer: { id: string; email?: string | null; created?: number; metadata?: Record<string, string> },
  now = new Date(),
): OperatorLicence {
  const meta = customer.metadata ?? {}
  const cancelAtPeriodEnd = meta.vector_cancel_at_period_end === "true"
  const state = licenceState({
    subscriptionStatus: meta.vector_subscription_status,
    revokedAt: meta.vector_revoked_at,
    cancelAtPeriodEnd,
    graceEndsAt: meta.vector_payment_grace_ends_at,
    now,
  })
  return {
    customerId: customer.id,
    email: meta.vector_email || customer.email || "",
    state,
    plan: meta.vector_plan || "annual",
    subscriptionStatus: meta.vector_subscription_status || "unknown",
    createdAt: customer.created ? new Date(customer.created * 1_000).toISOString() : undefined,
    periodEnd: timestamp(meta.vector_period_end),
    graceEndsAt: timestamp(meta.vector_payment_grace_ends_at),
    cancelAtPeriodEnd,
    deviceFingerprint: fingerprint(meta.vector_device_hash),
    deviceName: meta.vector_device_name || undefined,
    devicePlatform: meta.vector_device_platform || undefined,
    activatedAt: timestamp(meta.vector_activated_at),
    lastSeenAt: timestamp(meta.vector_last_seen_at),
    transferCount: count(meta.vector_transfer_count),
    downloadCount: count(meta.vector_download_count),
    licenceLast: meta.vector_license_last || undefined,
    revokedAt: timestamp(meta.vector_revoked_at),
  }
}

// A Vector licensee is a Stripe customer our checkout has issued a licence to.
// Filtering on this rather than listing every customer keeps unrelated Stripe
// records (test payments, other products) out of the console.
export function isVectorLicensee(customer: { metadata?: Record<string, string> }) {
  const meta = customer.metadata ?? {}
  return Boolean(meta.vector_license_hash || meta.vector_subscription_id || meta.vector_checkout_session_id)
}

export function summarise(licences: readonly OperatorLicence[]): LicenceSummary {
  const of = (state: OperatorLicenceState) => licences.filter((licence) => licence.state === state).length
  return {
    total: licences.length,
    active: of("active"),
    canceling: of("canceling"),
    grace: of("grace"),
    pastDue: of("past_due"),
    expired: of("expired"),
    revoked: of("revoked"),
    activated: licences.filter((licence) => licence.deviceFingerprint).length,
    neverActivated: licences.filter((licence) => !licence.deviceFingerprint).length,
  }
}

export function searchLicences(licences: readonly OperatorLicence[], query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...licences]
  return licences.filter((licence) =>
    [licence.email, licence.customerId, licence.deviceName, licence.licenceLast]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle)),
  )
}

export type OperatorAction = "release-device" | "revoke" | "restore" | "extend-grace"

export function isOperatorAction(value: unknown): value is OperatorAction {
  return value === "release-device" || value === "revoke" || value === "restore" || value === "extend-grace"
}

export const MAX_GRACE_EXTENSION_DAYS = 30

// The metadata patch for each action, kept as a pure function so the rules are
// testable without Stripe. Stripe deletes a metadata key when it is set to the
// empty string, which is how a field is cleared here.
export function actionPatch(input: {
  action: OperatorAction
  now: Date
  days?: number
}): Record<string, string> {
  switch (input.action) {
    case "release-device":
      // Frees a seat whose machine is gone. Clears the binding and the transfer
      // window too, so a customer who already used their moves this month is
      // not immediately blocked again by the limit that sent them to support.
      return {
        vector_device_hash: "",
        vector_device_name: "",
        vector_device_platform: "",
        vector_activation_hash: "",
        vector_transfer_count: "",
        vector_transfer_window_started_at: "",
        vector_deactivated_at: input.now.toISOString(),
      }
    case "revoke":
      // Also clears the activation hash, so the machine holding this licence
      // stops validating rather than keeping access until its next check.
      return {
        vector_revoked_at: input.now.toISOString(),
        vector_activation_hash: "",
        vector_device_hash: "",
        vector_device_name: "",
        vector_device_platform: "",
      }
    case "restore":
      return { vector_revoked_at: "" }
    case "extend-grace": {
      const days = Math.min(Math.max(Math.trunc(input.days ?? 7), 1), MAX_GRACE_EXTENSION_DAYS)
      const ends = new Date(input.now.getTime() + days * 24 * 60 * 60 * 1_000)
      return { vector_payment_grace_ends_at: ends.toISOString() }
    }
  }
}

export async function listVectorLicences(stripe: Stripe, limit = 1_000): Promise<OperatorLicence[]> {
  const licences: OperatorLicence[] = []
  let startingAfter: string | undefined
  const now = new Date()
  while (licences.length < limit) {
    const page: Stripe.ApiList<Stripe.Customer> = await stripe.customers.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    for (const customer of page.data) {
      if (!isVectorLicensee(customer)) continue
      licences.push(toOperatorLicence(customer, now))
    }
    if (!page.has_more || !page.data.length) break
    startingAfter = page.data[page.data.length - 1]?.id
    if (!startingAfter) break
  }
  return licences
}
