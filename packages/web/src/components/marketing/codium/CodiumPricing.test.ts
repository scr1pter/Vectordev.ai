import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { publicModelPlans } from "../../../../../../api/_lib/model-plan-config"
import { codiumPricing } from "../../../lib/codium-pricing"
import { readModelPlanConfig, type ModelPlanConfig } from "../../../lib/model-plans"
import { CodiumPricing, type CodiumMode } from "./CodiumPricing"

const config: ModelPlanConfig = {
  enabled: true,
  currency: "usd",
  interval: "month",
  product: "Vector Codium",
  plans: [
    { id: "vector-10", name: "Codium 10", price: 10, credits: 8, available: true },
    { id: "vector-20", name: "Codium 20", price: 20, credits: 16, available: true },
  ],
  topups: [
    { id: "codium-topup-10", name: "Codium 10 top-up", price: 10, credits: 8, available: true },
    { id: "codium-topup-20", name: "Codium 20 top-up", price: 20, credits: 16, available: true },
  ],
  models: [
    {
      id: "vendor/everyday-coder",
      name: "Everyday Coder",
      category: "everyday",
      description: "Routine edits and tests.",
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      inputPrice: 0.1,
      outputPrice: 0.6,
    },
    {
      id: "vendor/hard-coder",
      name: "Hard Coder",
      category: "advanced",
      contextLength: 128_000,
      maxOutputTokens: 8_192,
      inputPrice: 0.5,
      outputPrice: 3,
    },
  ],
}

const render = (value: ModelPlanConfig, mode?: CodiumMode) =>
  renderToStaticMarkup(createElement(CodiumPricing, { pricing: codiumPricing(value), mode }))

describe("Codium pricing page", () => {
  test("renders the free card and every configured tier with its credits, models and estimates", () => {
    const live = readModelPlanConfig(publicModelPlans())
    const html = render(live)
    expect(html).toContain("<h3>Free</h3>")
    expect(html).toContain('href="/login"')
    for (const plan of live.plans) {
      expect(html).toContain(`<h3>${plan.name}</h3>`)
      expect(html).toContain(`<strong>$${plan.price}</strong>`)
      expect(html).toContain(`${new Intl.NumberFormat("en-US").format(plan.credits * 100)} Codium credits every month`)
    }
    for (const model of live.models ?? []) expect(html).toContain(model.name)
    expect(html.match(/<article class="codium-card"/g)).toHaveLength(live.plans.length + 1)

    const sample = render(config)
    // $8 of model credit at 0.8 × $0.10 + 0.2 × $0.60 = $0.20 per million tokens.
    expect(sample).toContain("<td>≈ 40M</td>")
    expect(sample).toContain("<td>≈ 80M</td>")
    expect(sample).toContain("Est. 8M–40M tokens per month")
    expect(sample).toContain("Every Codium model: Everyday Coder and Hard Coder")
    expect(sample).toContain("Everything in Codium 10, and:")
    expect(sample).toContain("2× the credits of Codium 10")
    expect(sample).toContain("Billed by your provider")
    expect(sample).toContain("assuming 80% input and 20% output")
    expect(sample).toContain('href="/legal/terms#codium"')
  })

  test("the toggle switches between the monthly allowance and one-time top-ups", () => {
    const monthly = render(config)
    expect(monthly).toContain('role="group" aria-label="Purchase type"')
    expect(monthly).toMatch(/<button type="button" aria-pressed="true">.*Monthly plans<\/button>/)
    expect(monthly).toMatch(/<button type="button" aria-pressed="false">.*One-time top-ups<\/button>/)
    expect(monthly).toContain("<span>/ month</span>")
    expect(monthly).toContain("Get Codium 20")
    expect(monthly).toContain("Unused monthly credits reset when the period ends")
    expect(monthly).toContain("Cancel any time")
    expect(monthly).not.toContain("Codium 10 top-up")

    const topups = render(config, "topup")
    expect(topups).toMatch(/<button type="button" aria-pressed="true">.*One-time top-ups<\/button>/)
    expect(topups).toContain("<h3>Codium 10 top-up</h3>")
    expect(topups).toContain("<span>one-time</span>")
    expect(topups).toContain("Buy $20 top-up")
    expect(topups).toContain("1,600 Codium credits</li>")
    expect(topups).toContain("Credits carry forward with no expiry date")
    expect(topups).toContain("No subscription needed")
    expect(topups).toContain("Estimated tokens from each top-up")
    expect(topups).not.toContain("every month")
    expect(topups).not.toContain("Get Codium 20")

    const noTopups = render({ ...config, topups: undefined })
    expect(noTopups).not.toContain("aria-pressed")
  })

  test("with sales switched off every Codium button says Coming soon and is disabled", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const html = render(
        {
          ...config,
          enabled: false,
          plans: config.plans.map((plan) => ({ ...plan, available: false })),
          topups: config.topups?.map((pack) => ({ ...pack, available: false })),
        },
        mode,
      )
      expect(html).toContain("Codium purchases open soon")
      expect(html.match(/<button class="codium-button" type="button" disabled="">Coming soon<\/button>/g)).toHaveLength(
        2,
      )
      expect(html).not.toContain("Get Codium")
      expect(html).toContain('<a class="codium-button" href="/login">Get Free')
    }
    // A plan that reports itself available still waits while the product as a whole is off.
    expect(render({ ...config, enabled: false })).not.toContain("Get Codium 10")
    const live = render(config)
    expect(live).not.toContain("Coming soon")
    expect(live).not.toContain("open soon")
    expect(live).not.toContain("disabled")
  })

  test("never exposes model prices, dollar credits or the markup, in the page or its island props", () => {
    const pricing = codiumPricing(config)
    const props = JSON.stringify(pricing)
    expect(props).not.toContain("Price")
    expect(props).not.toContain("contextLength")
    expect(pricing.monthly.map((plan) => plan.credits)).toEqual([800, 1600])
    expect(pricing.topups.map((pack) => pack.credits)).toEqual([800, 1600])
    for (const mode of ["monthly", "topup"] as const) {
      const html = render(config, mode)
      for (const value of ["markup", "margin", "per million", "$0.1", "$0.6", "$0.5", "$3", "$8", "$16", "25%"])
        expect(html).not.toContain(value)
    }
    const live = readModelPlanConfig(publicModelPlans())
    const html = render(live)
    for (const plan of live.plans) expect(html).not.toContain(`$${plan.credits}<`)
    for (const model of live.models ?? []) {
      expect(html).not.toContain(`$${model.inputPrice}`)
      expect(html).not.toContain(`$${model.outputPrice}`)
    }
  })

  test("questions are an accordion of buttons that each control their own answer", () => {
    const html = render(config)
    const buttons = [...html.matchAll(/aria-expanded="(true|false)" aria-controls="([^"]+)"/g)]
    expect(buttons.map((match) => match[1])).toEqual(["true", "false", "false", "false", "false", "false", "false"])
    for (const match of buttons) expect(html).toContain(`id="${match[2]}"`)
    expect(html).toContain('<div class="codium-faq-answer" id="codium-faq-credits">')
    expect(html).toContain('<div class="codium-faq-answer" id="codium-faq-run-out" hidden="">')
    for (const question of [
      "How do Codium credits work?",
      "What happens when I run out of credits?",
      "What&#x27;s the difference between monthly and top-up credits?",
      "Can I use my own API keys instead?",
      "Which models are included?",
      "How do I change or cancel my plan?",
      "Where can I see my balance?",
    ])
      expect(html).toContain(question)
    expect(html).toContain("<strong>Hard Coder</strong>")
    expect(html).toContain('href="/account"')
  })

  test("/pricing sends visitors to the Codium page, which the deploy keeps", async () => {
    const vercel = await Bun.file(new URL("../../../../../../vercel.json", import.meta.url)).json()
    expect(vercel.redirects).toContainEqual({ source: "/pricing", destination: "/codium", permanent: false })
    expect(await Bun.file(new URL("../../../../../../script/prune-vector-site.mjs", import.meta.url)).text()).toContain(
      '"codium"',
    )
  })
})
