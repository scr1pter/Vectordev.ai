import { describe, expect, test } from "bun:test"
import { billingNotice, offerAction, offerPrice } from "./codium-billing"

const offer = (id: string, price: number, available = true) => ({ id, name: `Codium ${price}`, price, available })

describe("Codium offers in Vector", () => {
  test("nothing can be bought while Codium is not on sale: every button reads Coming soon", () => {
    for (const [item, kind] of [
      [offer("vector-10", 10, false), "plan"],
      [offer("codium-topup-10", 10, false), "topup"],
    ] as const)
      expect(offerAction(item, kind)).toEqual({ label: "Coming soon" })
  })

  test("someone without a plan subscribes; a subscriber sees their plan and changes it in the portal", () => {
    expect(offerAction(offer("vector-50", 50), "plan")).toEqual({
      label: "Subscribe",
      request: { kind: "checkout", plan: "vector-50" },
    })
    expect(offerAction(offer("vector-50", 50), "plan", { id: "vector-50" })).toEqual({
      label: "Current plan",
      current: true,
    })
    expect(offerAction(offer("vector-100", 100), "plan", { id: "vector-50" })).toBeUndefined()
    expect(offerAction(offer("codium-topup-50", 50), "topup", { id: "vector-50" })).toEqual({
      label: "Buy",
      request: { kind: "topup", pack: "codium-topup-50" },
    })
  })

  test("shows the public price and never what it buys", () => {
    expect(offerPrice(offer("vector-50", 50), "plan")).toBe("$50 a month")
    expect(offerPrice(offer("codium-topup-200", 200), "topup")).toBe("$200 once")
  })
})

describe("after the billing window", () => {
  test("says what happened in plain words, and nothing when the person only looked", () => {
    expect(billingNotice({ kind: "checkout", plan: "vector-10" }, { outcome: "completed" })).toEqual({
      kind: "done",
      text: "You are subscribed. Your monthly credits appear here in a moment.",
    })
    expect(billingNotice({ kind: "topup", pack: "codium-topup-10" }, { outcome: "completed" })?.kind).toBe("done")
    expect(billingNotice({ kind: "portal", flow: "change" }, { outcome: "completed" })?.text).toBe(
      "Your plan change is saved.",
    )
    expect(billingNotice({ kind: "portal", flow: "cancel" }, { outcome: "completed" })?.text).toContain(
      "until the end of this billing period",
    )
    expect(billingNotice({ kind: "checkout", plan: "vector-10" }, { outcome: "cancelled" })?.text).toBe(
      "Checkout was cancelled. Nothing was charged.",
    )
    expect(billingNotice({ kind: "portal" }, { outcome: "closed" })).toBeUndefined()
    expect(billingNotice({ kind: "portal" }, { outcome: "website" })?.text).toBe(
      "This continues on vectordev.ai in your browser.",
    )
    expect(
      billingNotice({ kind: "portal" }, { outcome: "failed", message: "Billing is temporarily unavailable." }),
    ).toEqual({ kind: "error", text: "Billing is temporarily unavailable." })
  })
})
