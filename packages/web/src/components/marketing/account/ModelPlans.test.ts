import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ModelPlans, type ModelPlansPreview } from "./ModelPlans"

const config: ModelPlansPreview["config"] = {
  enabled: true,
  currency: "usd",
  interval: "month",
  plans: [{ id: "vector-10", name: "Vector 10", price: 10, available: true }],
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

  test("disabled purchase configuration shows the price and offers nothing to buy", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config: { ...config, enabled: false, plans: [{ ...config.plans[0]!, available: false }] },
          status: { active: false },
        },
      }),
    )
    expect(html).toContain("$10")
    expect(html).toContain("Purchasing is not available yet")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Coming soon<\/button>/)
    expect(html).not.toContain("Choose Vector 10")
  })

  test("active subscriptions show the share of credits remaining, renewal and management", () => {
    const html = renderToStaticMarkup(createElement(ModelPlans, { accessToken: "", preview: { config, status } }))
    expect(html).toContain("<strong>25%</strong> of this month&#x27;s Codium credits")
    expect(html).toContain('value="25" max="100"')
    // Amounts, with the price, would give away the dollars of model credit in the plan.
    expect(html.replace(/<progress[^>]*>/, "")).not.toMatch(/\b(100|10,000|2,500|75)\b/)
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

  test("each offer shows typical tasks on the default model, never credits or token estimates", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: {
          config: {
            ...config,
            enabled: false,
            product: "Vector Codium",
            plans: [{ ...config.plans[0]!, name: "Codium 10", available: false, tasks: [[60, 550], null] }],
            topups: [
              { id: "codium-topup-10", name: "Codium 10 top-up", price: 10, available: false, tasks: [[60, 550]] },
            ],
            models: [
              { id: "vendor/coder", name: "Coding Model", category: "everyday", description: "Routine coding tasks." },
              { id: "vendor/hard", name: "Hard Model", category: "advanced" },
            ],
          },
          status: { active: false },
        },
      }),
    )
    expect(html).toContain("Monthly subscriptions")
    expect(html).toContain("One-time credit packs")
    expect(html).toContain("About 60–550 typical tasks a month with Coding Model")
    expect(html).toContain("About 60–550 typical tasks with Coding Model")
    expect(html).toContain("Credits carry forward")
    expect(html).toContain("do not roll over")
    expect(html).toContain("no automatic top-ups")
    expect(html).toContain("Everyday")
    expect(html).toContain("reasoning affect usage")
    expect(html).toContain("repeated context also counts")
    expect(html).toContain("not a guarantee")
    expect(html).toContain('href="/legal/terms#codium"')
    expect(html).toContain("Cancel any time")
    for (const leak of ["Codium credits /", "800", "tokens", "80% input", "markup"]) expect(html).not.toContain(leak)
  })

  test("monthly and purchased balances remain distinct, including unknown purchased usage", () => {
    const html = renderToStaticMarkup(
      createElement(ModelPlans, {
        accessToken: "",
        preview: { config, status: { ...status, access: true, wallet: { credits: 8, remaining: 6 } } },
      }),
    )
    expect(html).toContain("Monthly allowance")
    expect(html).toContain("<strong>25%</strong> of this month&#x27;s Codium credits")
    // Purchased credits pool every top-up ever bought, so they read as a state, not a share of that pool.
    expect(html).toContain("Purchased Codium credits available")
    expect(html).not.toContain("75%")
    const state = (wallet: { credits: number; remaining: number }) =>
      renderToStaticMarkup(
        createElement(ModelPlans, {
          accessToken: "",
          preview: { config, status: { active: false, access: true, wallet } },
        }),
      )
    expect(state({ credits: 1600, remaining: 15 })).toContain("Purchased Codium credits available")
    expect(state({ credits: 1600, remaining: 0.5 })).toContain("Your purchased Codium credits are running low")
    expect(state({ credits: 1600, remaining: 0 })).toContain("Your purchased Codium credits are used up")
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
