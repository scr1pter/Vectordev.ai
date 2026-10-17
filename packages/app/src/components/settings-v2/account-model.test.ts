import { describe, expect, test } from "bun:test"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { accountIdentity, codiumSummary } from "./account-model"

const renewsAt = Date.UTC(2026, 10, 1, 12)

function status(input: Partial<ModelPlanStatus.Status> = {}): ModelPlanStatus.Status {
  return {
    signedIn: true,
    enabled: true,
    access: true,
    purchased: { bought: false },
    empty: false,
    low: false,
    ...input,
  }
}

describe("Codium on the Account page", () => {
  test("waits for the desktop, then follows the sign-in", () => {
    expect(codiumSummary()).toEqual({ kind: "loading" })
    expect(codiumSummary(status({ signedIn: false }))).toEqual({ kind: "signed-out" })
    expect(codiumSummary(status({ signedIn: false, error: "Your Vector sign-in expired. Sign in again." }))).toEqual({
      kind: "error",
      text: "Your Vector sign-in expired. Sign in again.",
    })
  })

  test("is Coming soon while sales are off and the account has bought nothing", () => {
    expect(codiumSummary(status({ enabled: false, access: false }))).toEqual({ kind: "coming-soon" })
  })

  test("shows the plan and the share of this month's credits left, never an amount", () => {
    const summary = codiumSummary(
      status({
        plan: { id: "vector-50", name: "Codium 50", left: 0.4237, renewsAt, cancelAtPeriodEnd: false },
        purchased: { bought: true, state: "low" },
      }),
    )
    expect(summary).toMatchObject({
      kind: "plan",
      plan: "Codium 50",
      left: 0.4237,
      credits: "42% of this month's credits left",
      renewal: { label: "Renews", date: ModelPlanStatus.formatDate(renewsAt) },
      purchased: "Running low",
      billing: true,
      purchase: true,
    })
    if (summary.kind !== "plan") throw new Error("Expected the plan summary")
    // The balance lines carry a percentage and a state, never a credit count.
    expect(`${summary.credits} ${summary.purchased}`).not.toMatch(/\d(?!\d*%)/)
  })

  test("names an ending plan, an unverified balance and an account with no plan", () => {
    expect(
      codiumSummary(status({ plan: { id: "vector-10", name: "Codium 10", renewsAt, cancelAtPeriodEnd: true } })),
    ).toMatchObject({ credits: "Balance unavailable", renewal: { label: "Ends" } })
    const none = codiumSummary(status())
    expect(none).toMatchObject({ kind: "plan", plan: "No plan", purchased: "None", billing: false, purchase: true })
    expect(none).not.toHaveProperty("credits")
    expect(none).not.toHaveProperty("renewal")
  })

  test("keeps a subscriber's plan visible when sales pause, with the server's notice", () => {
    const summary = codiumSummary(
      status({
        enabled: false,
        plan: { id: "vector-10", name: "Codium 10", left: 1, renewsAt, cancelAtPeriodEnd: false },
      }),
    )
    expect(summary).toMatchObject({ kind: "plan", plan: "Codium 10", purchase: false, billing: true })
    expect(summary).toMatchObject({ notice: { kind: "unavailable" } })
  })

  test("passes on the low and empty notices", () => {
    expect(codiumSummary(status({ low: true }))).toMatchObject({ notice: { kind: "low" } })
    expect(codiumSummary(status({ access: false }))).toMatchObject({ notice: { kind: "empty" } })
  })
})

describe("account identity", () => {
  test("leads with the name and keeps the email under it", () => {
    expect(accountIdentity({ name: "Ana Diaz", email: "ana@example.com" })).toEqual({
      title: "Ana Diaz",
      detail: "ana@example.com",
    })
  })

  test("shows the email alone when the account has no name", () => {
    expect(accountIdentity({ name: "  ", email: "ana@example.com" })).toEqual({
      title: "ana@example.com",
      detail: undefined,
    })
    expect(accountIdentity({})).toEqual({ title: "", detail: undefined })
  })
})
