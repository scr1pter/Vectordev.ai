import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ModelPlans, type ModelPlansPreview } from "./ModelPlans"

const config: ModelPlansPreview["config"] = {
  enabled: true,
  currency: "usd",
  interval: "month",
  plans: [{ id: "vector-10", name: "Vector 10", price: 10, credits: 100, available: true }],
}
const status: ModelPlansPreview["status"] = {
  active: true,
  plan: "vector-10",
  credits: 100,
  used: 75,
  remaining: 25,
  periodStart: Date.UTC(2026, 9, 1),
  periodEnd: Date.UTC(2026, 10, 1),
  cancelAtPeriodEnd: false,
}

describe("account model plans", () => {
  test("loading and signed-out views never offer checkout before subscription status is known", () => {
    const loading = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "pending-session" }))
    expect(loading).toContain("Loading model plans")
    expect(loading).toContain('aria-busy="true"')
    expect(loading).not.toContain("<button")
    const signedOut = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "" }))
    expect(signedOut).toContain("Sign in to view your model plan")
    expect(signedOut).not.toContain("Loading model plans")
  })

  test("disabled purchase configuration shows the price with an honest pending allowance", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config: { ...config, enabled: false, plans: [{ ...config.plans[0]!, credits: 0, available: false }] },
          status: { active: false },
        },
      }),
    )
    expect(html).toContain("$10")
    expect(html).toContain("Credit allowance to be announced")
    expect(html).toContain("Purchasing is not available yet")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Coming soon<\/button>/)
    expect(html).not.toContain("Choose Vector 10")
  })

  test("active subscriptions show remaining credits, renewal and management", () => {
    const html = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: { config, status } }))
    expect(html).toContain("<strong>2,500</strong> Codium credits remaining")
    expect(html).toContain('value="2500" max="10000"')
    expect(html).toContain("Renews")
    expect(html).toContain("Manage subscription")
    expect(html).toContain("Current plan")
  })

  test("missing usage stays unknown and cancellation does not promise renewal", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: { config, status: { ...status, used: undefined, remaining: undefined, cancelAtPeriodEnd: true } },
      }),
    )
    expect(html).toContain("Usage temporarily unavailable")
    expect(html).toContain("Ending this period")
    expect(html).toContain("Access ends")
    expect(html).not.toContain("Renews")
    expect(html).not.toContain("<progress")
  })

  test("the account design preview never enables a billing action", () => {
    const html = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: true }))
    expect(html).toContain("Vector Codium is coming soon")
    expect(html).not.toContain("Loading model plans")
    expect(html).not.toContain("<button")
  })

  test("existing subscribers and billing customers can still find management while purchases are disabled", () => {
    for (const subscription of [status, { active: false as const, customer: true }]) {
      const html = renderToStaticMarkup(
        createElement(ModelPlans, {
          accessToken: "",
          preview: { config: { ...config, enabled: false }, status: subscription },
        }),
      )
      expect(html).toContain("Purchasing is not available yet")
      expect(html).toContain("Manage subscription")
      expect(html).not.toContain("Choose Vector 10")
    }
  })

  test("the public Codium page shows credits and token estimates without supplier costs or an account", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        publicConfig: {
          ...config,
          enabled: false,
          product: "Vector Codium",
          plans: [{ ...config.plans[0]!, name: "Codium 10", credits: 8, available: false }],
          topups: [{ id: "codium-topup-10", name: "$10 credit pack", price: 10, credits: 8, available: false }],
          models: [
            {
              id: "vendor/coder",
              name: "Coding Model",
              category: "everyday",
              description: "Routine coding tasks.",
              contextLength: 128_000,
              maxOutputTokens: 8_192,
              inputPrice: 0.075,
              outputPrice: 0.2,
            },
          ],
        },
      }),
    )
    expect(html).toContain("Monthly subscriptions")
    expect(html).toContain("One-time credit packs")
    expect(html).toContain("800 Codium credits")
    expect(html).toContain("Credits carry forward")
    expect(html).toContain("do not roll over")
    expect(html).toContain("no automatic top-ups")
    expect(html).toContain("Coding Model")
    expect(html).not.toContain("$0.075")
    expect(html).not.toContain("$0.20")
    expect(html).not.toContain("USD model credits")
    expect(html).not.toContain("markup")
    expect(html).toContain("Est. 80M tokens")
    expect(html).toContain("Everyday")
    expect(html).toContain("reasoning affect usage")
    expect(html).toContain("repeated context also counts")
    expect(html).toContain("not a guarantee")
    expect(html).toContain('href="/legal/terms#codium"')
    expect(html).toContain("Cancel any time")
    expect(html.match(/disabled=""/g)).toHaveLength(2)
    expect(html).not.toContain("Sign in to view")
    expect(html).not.toContain("Loading model plans")
    expect(html).not.toContain("Refresh plan")
    expect(html).not.toContain("stripe.com")
  })

  test("the public page links to the account rather than performing checkout", () => {
    const html = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", publicConfig: config }))
    expect(html).toContain('href="/account"')
    expect(html).not.toContain("stripe.com")
  })

  test("monthly and purchased balances remain distinct, including unknown purchased usage", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: { config, status: { ...status, access: true, wallet: { credits: 8, remaining: 6 } } },
      }),
    )
    expect(html).toContain("Monthly allowance")
    expect(html).toContain("<strong>2,500</strong> Codium credits remaining")
    expect(html).toContain("<strong>600</strong> purchased Codium credits remaining")
    const standalone = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: { config, status: { active: false, access: true, wallet: { credits: 8 } } },
      }),
    )
    expect(standalone).toContain("Purchased credits")
    expect(standalone).toContain("Usage temporarily unavailable")
    expect(standalone).not.toContain("Monthly allowance")
    expect(standalone).not.toContain("Renews")
  })
})
