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
      expect(html).toContain(
        `<p>${new Intl.NumberFormat("en-US").format(plan.credits * 100)} Codium credits every month</p>`,
      )
    }
    for (const model of live.models ?? []) expect(html).toContain(model.name)
    expect(html.match(/<article class="codium-card"/g)).toHaveLength(live.plans.length + 1)

    const sample = render(config)
    // $8 of model credit at 0.8 × $0.10 + 0.2 × $0.60 = $0.20 per million tokens.
    expect(sample).toContain("<td>≈ 40M</td>")
    expect(sample).toContain("<td>≈ 80M</td>")
    expect(sample).toContain("<p>Est. 8M–40M tokens per month</p>")
    expect(sample).toContain("Every Codium model: Everyday Coder and Hard Coder")
    expect(sample).toContain('<p class="codium-everything">Everything in Codium 10, with:</p>')
    expect(sample).toContain("2× the credits</li>")
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
    expect(monthly).toContain("Renews monthly until you cancel; access lasts the paid period")
    expect(monthly).not.toContain("Codium 10 top-up")

    const topups = render(config, "topup")
    expect(topups).toMatch(/<button type="button" aria-pressed="true">.*One-time top-ups<\/button>/)
    expect(topups).toContain("<h3>Codium 10 top-up</h3>")
    expect(topups).toContain("<span>one-time</span>")
    expect(topups).toContain("Buy $20 top-up")
    expect(topups).toContain("<p>1,600 Codium credits</p>")
    expect(topups).toContain("Unused credits carry forward separately from any plan")
    expect(topups).toContain("No subscription needed")
    expect(topups).toContain("Estimated tokens from each top-up")
    expect(topups).not.toContain("every month")
    expect(topups).not.toContain("Get Codium 20")

    const noTopups = render({ ...config, topups: undefined })
    expect(noTopups).not.toContain("aria-pressed")
  })

  test("a later tier carries over features only, so its credits never read as adding to the tier before it", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const html = render(readModelPlanConfig(publicModelPlans()), mode)
      const text = html.replace(/<[^>]+>/g, "\n")
      // Whatever follows "Everything in <tier>" up to the end of that card never names an amount of credits or tokens.
      const carried = [...html.matchAll(/<p class="codium-everything">(.*?)<\/article>/g)].map((match) => match[1]!)
      expect(carried).toHaveLength(3)
      for (const part of carried) {
        expect(part).not.toMatch(/\d[\d,]* Codium credits/)
        expect(part).not.toMatch(/tokens/)
      }
      expect(text).not.toMatch(/Everything in [^\n]*, (and|plus):/)
      // Each card states its own amount once, in its allowance, and later tiers say how many times the first they are.
      expect(html).toContain(`<p>16,000 Codium credits${mode === "monthly" ? " every month" : ""}</p>`)
      expect(html).toContain("20× the credits</li>")
      expect(html.match(/Codium credits( every month)?<\/p>/g)).toHaveLength(4)
    }
  })

  test("renewal, carry-forward and balance copy matches the Codium terms and what Vector shows today", async () => {
    const monthly = render(config)
    // Automatic renewal is stated above the plan buttons, not only inside a collapsed answer.
    expect(monthly.indexOf("Plans renew automatically every month at the listed price until you cancel.")).toBeLessThan(
      monthly.indexOf('class="codium-button"'),
    )
    const terms = await Bun.file(new URL("../../../pages/legal/terms.astro", import.meta.url)).text()
    expect(terms).toContain("renew automatically at the")
    expect(terms).toContain("carry forward separately from your subscription")
    for (const html of [monthly, render(config, "topup")]) {
      // The terms promise carry-forward, not credits that never expire.
      expect(html).not.toMatch(/expiry|never expire|no expiration/i)
      // Balances are on the account page; the page doesn't promise an in-app balance view.
      expect(html).not.toContain("In the Vector app")
      expect(html).toContain('On your <a href="/account">account page</a>')
    }
    expect(render(config, "topup")).toContain("unused credits carry forward separately from your subscription")
  })

  test("says where Codium sends code and links the privacy policy within the page itself", () => {
    const html = render(config)
    // The site footer isn't part of this island, so this link is the page's own.
    expect(html).toContain('<a href="/legal/privacy">privacy policy</a>')
    expect(html).toContain("go through Vector and OpenRouter to a provider serving the model you picked")
    expect(html).toContain("zero-data-retention endpoints")
  })

  test("headings step down one level at a time below the page title", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const levels = [...render(config, mode).matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]))
      // The page's own h1 sits above this island, so the island starts at h2.
      expect(levels[0]).toBe(2)
      for (const [index, level] of levels.entries())
        if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
      expect(render(config, mode)).toContain('<h2 class="codium-visually-hidden">Plans</h2>')
    }
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
