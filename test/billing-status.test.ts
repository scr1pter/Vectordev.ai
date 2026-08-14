import { describe, expect, test } from "bun:test"
import type Stripe from "stripe"
import { publicStatus } from "../api/_lib/billing"

const subscription = (input: { status: Stripe.Subscription.Status; plan: "annual" | "monthly"; periodEnd: number }) =>
  ({
    status: input.status,
    cancel_at_period_end: false,
    ended_at: null,
    metadata: { vector_plan: input.plan },
    items: {
      data: [
        {
          current_period_end: input.periodEnd,
          price: { recurring: { interval: input.plan === "monthly" ? "month" : "year" } },
        },
      ],
    },
  }) as unknown as Stripe.Subscription

const customer = (metadata: Record<string, string> = {}) =>
  ({
    email: "buyer@example.com",
    metadata,
  }) as unknown as Stripe.Customer

describe("Vector license status", () => {
  test("keeps the existing annual plan active", () => {
    const now = Math.floor(Date.now() / 1_000)
    expect(
      publicStatus(customer(), subscription({ status: "active", plan: "annual", periodEnd: now + 86_400 })),
    ).toMatchObject({
      access: true,
      state: "active",
      plan: "annual",
      interval: "year",
      priceUsd: 99,
    })
  })

  test("keeps a monthly license active during its three-day payment grace period", () => {
    const now = Math.floor(Date.now() / 1_000)
    const status = publicStatus(
      customer({
        vector_plan: "monthly",
        vector_payment_failed_at: `${now - 60}`,
        vector_payment_grace_ends_at: `${now + 3 * 86_400 - 60}`,
      }),
      subscription({ status: "past_due", plan: "monthly", periodEnd: now - 60 }),
    )

    expect(status).toMatchObject({ access: true, state: "grace", plan: "monthly", interval: "month", priceUsd: 10 })
    expect(status.graceEndsAt).toBeTruthy()
  })

  test("honors the recorded monthly grace period before Stripe updates its status", () => {
    const now = Math.floor(Date.now() / 1000)
    const active = subscription({ status: "active", plan: "monthly", periodEnd: now + 86_400 })
    const buyer = customer({
      vector_plan: "monthly",
      vector_payment_failed_at: `${now - 60}`,
      vector_payment_grace_ends_at: `${now + 86_400}`,
    })
    expect(publicStatus(buyer, active)).toMatchObject({ access: true, state: "grace", plan: "monthly" })
  })

  test("expires a monthly license after payment grace ends", () => {
    const now = Math.floor(Date.now() / 1_000)
    const status = publicStatus(
      customer({
        vector_plan: "monthly",
        vector_payment_failed_at: `${now - 4 * 86_400}`,
        vector_payment_grace_ends_at: `${now - 86_400}`,
      }),
      subscription({ status: "past_due", plan: "monthly", periodEnd: now - 4 * 86_400 }),
    )

    expect(status).toMatchObject({ access: false, state: "expired", plan: "monthly" })
  })

  test("does not grant grace to a failed initial monthly payment", () => {
    const now = Math.floor(Date.now() / 1_000)
    const status = publicStatus(
      customer({
        vector_plan: "monthly",
        vector_payment_failed_at: `${now - 60}`,
        vector_payment_failure_kind: "initial",
      }),
      subscription({ status: "past_due", plan: "monthly", periodEnd: now + 86_400 }),
    )

    expect(status).toMatchObject({ access: false, state: "past_due", plan: "monthly" })
  })

  test("does not grant the monthly grace period to an annual plan", () => {
    const now = Math.floor(Date.now() / 1_000)
    const status = publicStatus(
      customer({
        vector_plan: "annual",
        vector_payment_failed_at: `${now - 60}`,
        vector_payment_failure_kind: "renewal",
        vector_payment_grace_ends_at: `${now + 3 * 86_400}`,
      }),
      subscription({ status: "past_due", plan: "annual", periodEnd: now - 60 }),
    )

    expect(status).toMatchObject({ access: false, state: "past_due", plan: "annual" })
  })
})
