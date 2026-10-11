import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { publicModelPlans } from "../../../../../../api/_lib/model-plan-config"
import { codiumPricing } from "../../../lib/codium-pricing"
import { readModelPlanConfig, type ModelPlanConfig } from "../../../lib/model-plans"
import { CodiumPricing, codiumMode, codiumModeUrl, type CodiumMode } from "./CodiumPricing"

const config: ModelPlanConfig = {
  enabled: true,
  currency: "usd",
  interval: "month",
  product: "Vector Codium",
  plans: [
    { id: "vector-10", name: "Codium 10", price: 10, available: true, tasks: [[60, 550], null] },
    { id: "vector-50", name: "Codium 50", price: 50, available: true, multiple: 5, tasks: [[300, 2700], null] },
  ],
  topups: [
    { id: "codium-topup-10", name: "Codium 10 top-up", price: 10, available: true, tasks: [[60, 550], null] },
    {
      id: "codium-topup-50",
      name: "Codium 50 top-up",
      price: 50,
      available: true,
      multiple: 5,
      tasks: [
        [300, 2700],
        [160, 1400],
      ],
    },
  ],
  models: [
    { id: "deepseek/deepseek-v4.1-flash", name: "Everyday Coder", category: "everyday", description: "Routine edits." },
    { id: "vendor/unreviewed", name: "Hard Coder", category: "advanced" },
  ],
}
// The deployed configuration. The task assumptions are private, so this repository builds it without usage ranges.
const live = readModelPlanConfig(publicModelPlans())
// The deployed configuration with sales switched on, as it will be at launch.
const selling: ModelPlanConfig = {
  ...live,
  enabled: true,
  plans: live.plans.map((plan) => ({ ...plan, available: true })),
  topups: live.topups?.map((pack) => ({ ...pack, available: true })),
}

const render = (value: ModelPlanConfig, mode?: CodiumMode) =>
  renderToStaticMarkup(createElement(CodiumPricing, { pricing: codiumPricing(value), mode }))
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")

describe("Codium pricing page", () => {
  test("offers exactly the four monthly plans, with no free card", () => {
    const html = render(selling)
    expect(live.plans.map((plan) => plan.price)).toEqual([10, 50, 100, 200])
    expect(html.match(/<article class="cx-card"/g)).toHaveLength(4)
    for (const plan of live.plans) {
      expect(html).toContain(`<h3>Codium ${plan.price}</h3>`)
      expect(html).toContain(`<span class="cx-amount">$${plan.price}</span><span class="cx-period">/ month</span>`)
      expect(html).toContain(`Get Codium ${plan.price}<svg`)
    }
    expect(html).not.toContain(">Free<")
    expect(html).not.toContain("$0")
    expect(html).not.toMatch(/Codium 20(?!0)/)
    // Each later tier starts from the first and states only what differs, as a multiple of its credits.
    expect(html.match(/<p class="cx-everything">Everything in Codium 10, and:<\/p>/g)).toHaveLength(3)
    for (const multiple of [5, 10, 20]) expect(html).toContain(`${multiple}× the monthly credits of Codium 10</li>`)
    expect(html).toContain("Monthly credits for every Codium model</li>")
    expect(html).toContain("Works in the Vector desktop app and CLI</li>")
  })

  test("later tiers list their usage on the default and advanced models, never their credits", () => {
    const monthly = text(render(config))
    expect(monthly).toContain(
      "Everything in Codium 10, and: 5× the monthly credits of Codium 10 About 300–2,700 typical tasks a month with Everyday Coder",
    )
    // A model without a range gets no line.
    expect(monthly).not.toContain("with Hard Coder")
    const topups = text(render(config, "topup"))
    expect(topups).toContain(
      "5× the $10 top-up's credits About 300–2,700 typical tasks with Everyday Coder About 160–1,400 typical tasks with Hard Coder",
    )
    // Without ranges or a multiple, a later card has nothing to add and no header promising more.
    const bare = render({ ...config, plans: config.plans.map((plan) => ({ ...plan, multiple: undefined, tasks: [] })) })
    expect(bare).not.toContain("Everything in")
  })

  test("top-ups are the same four amounts as one-time packs in the same cards", () => {
    const html = render(selling, "topup")
    expect(live.topups?.map((pack) => pack.price)).toEqual([10, 50, 100, 200])
    expect(html.match(/<article class="cx-card"/g)).toHaveLength(4)
    for (const pack of live.topups ?? []) {
      expect(html).toContain(`<span class="cx-amount">$${pack.price}</span><span class="cx-period">one-time</span>`)
      expect(html).toContain(`Buy $${pack.price} top-up<svg`)
    }
    expect(html).not.toContain("/ month")
    expect(html).not.toContain("Get Codium")
    expect(html.match(/Everything in the \$10 top-up, and:/g)).toHaveLength(3)
    expect(html).toContain("20× the $10 top-up&#x27;s credits</li>")
    expect(html).toContain("Unused credits carry forward separately from any plan</li>")
    expect(html).toContain("No subscription needed</li>")
    expect(html).toContain("Unused top-up credits carry forward separately from your subscription.")
    expect(html).not.toMatch(/never expire|no expiration/i)
  })

  test("the purchase type is a two-option radiogroup with one tab stop", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const html = render(config, mode)
      expect(html).toContain('<div class="cx-toggle" role="radiogroup" aria-label="Choose how to buy Codium">')
      const radios = [
        ...html.matchAll(/role="radio" aria-checked="(true|false)" tabindex="(0|-1)"[^>]*>(.*?)<\/button>/g),
      ]
      expect(radios.map((match) => text(match[3]!).trim())).toEqual(["Individual", "Top-ups"])
      expect(radios.map((match) => [match[1], match[2]])).toEqual(
        mode === "monthly"
          ? [
              ["true", "0"],
              ["false", "-1"],
            ]
          : [
              ["false", "-1"],
              ["true", "0"],
            ],
      )
      // Each option carries a 16px icon beside its label.
      for (const match of radios) expect(match[3]).toContain('width="16" height="16"')
    }
    expect(render({ ...config, topups: undefined })).not.toContain('role="radiogroup"')
  })

  test("the tab is kept in the address, so links, reloads and history restore it", () => {
    expect(codiumMode("")).toBe("monthly")
    expect(codiumMode("?type=topups")).toBe("topup")
    expect(codiumMode("?type=team&ref=x")).toBe("monthly")
    expect(codiumModeUrl("https://vectordev.ai/codium", "topup").href).toBe("https://vectordev.ai/codium?type=topups")
    expect(codiumModeUrl("https://vectordev.ai/codium?type=topups&ref=x#faq", "monthly").href).toBe(
      "https://vectordev.ai/codium?ref=x#faq",
    )
    expect(codiumMode(codiumModeUrl("https://vectordev.ai/codium?ref=x", "topup").search)).toBe("topup")
  })

  test("the renewal terms sit above the plan buttons and at the end of the plans", async () => {
    const page = await Bun.file(new URL("../../../pages/codium.astro", import.meta.url)).text()
    expect(page.indexOf("monthly plans that renew until you cancel")).toBeGreaterThan(-1)
    expect(page.indexOf("monthly plans that renew until you cancel")).toBeLessThan(page.indexOf("<CodiumPricing"))
    const monthly = render(config)
    expect(monthly).toContain(
      "Plans renew monthly at the listed price until you cancel. Monthly credits reset each billing period and don&#x27;t roll over.",
    )
    expect(monthly.match(/class="cx-fine"/g)).toHaveLength(1)
    expect(monthly.lastIndexOf("<article")).toBeLessThan(monthly.indexOf('class="cx-fine"'))
    const terms = await Bun.file(new URL("../../../pages/legal/terms.astro", import.meta.url)).text()
    expect(terms).toContain("renew automatically at the")
    expect(terms).toContain("carry forward separately from your subscription")
    expect(monthly).toContain('<a href="/legal/terms#codium">Codium terms</a>')
  })

  test("usage is shown as ranges of typical tasks for each model and plan", () => {
    const html = render(config)
    expect(html).toContain('<h2 id="cx-usage-heading">Usage estimates</h2>')
    const header = [...html.matchAll(/<th scope="col">(.*?)<\/th>/g)].map((match) => match[1])
    expect(header).toEqual(["Model", "Codium 10", "Codium 50", "Your own key"])
    const rows = [...html.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((match) => [
      match[1],
      [...match[2]!.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => cell[1]),
    ])
    expect(rows).toEqual([
      ["Everyday Coder", ["60–550", "300–2,700", '<a href="/docs/models">Usage-based</a>']],
      ["Hard Coder", ["–", "–", '<a href="/docs/models">Usage-based</a>']],
    ])
    expect(html).toContain("Typical agent tasks a month on each plan")
    expect(render(config, "topup")).toContain("Typical agent tasks from each one-time top-up")
  })

  test("without the private task assumptions the page leaves the usage estimates out", () => {
    const html = render(live)
    expect(codiumPricing(live).monthly.every((offer) => offer.tasks.every((tasks) => tasks === null))).toBe(true)
    expect(html).not.toContain("cx-usage")
    expect(html).not.toContain("typical tasks")
    expect(html).toContain("5× the monthly credits of Codium 10")
    expect(codiumPricing(live).models.map((model) => model.name)).toEqual([
      "DeepSeek V4.1 Flash",
      "Xiaomi MiMo V2.6 Flash",
      "Claude Haiku 5.5",
    ])
    expect(codiumPricing(live).models.find((model) => model.category === "advanced")?.description).toContain(
      "Uses credits faster than the other models",
    )
  })

  test("never exposes credit amounts, model prices or the markup, in the page or its island props", () => {
    for (const value of [config, live]) {
      const pricing = codiumPricing(value)
      for (const offer of [...pricing.monthly, ...pricing.topups])
        expect(Object.keys(offer).sort()).toEqual(["available", "id", "multiple", "name", "price", "tasks"])
      for (const model of pricing.models)
        expect(Object.keys(model).every((key) => ["id", "name", "category", "description"].includes(key))).toBe(true)
      const props = JSON.stringify(pricing)
      for (const key of ["credits", "inputPrice", "outputPrice", "contextLength"])
        expect(props).not.toContain(`"${key}"`)
      for (const mode of ["monthly", "topup"] as const) {
        const html = render(value, mode)
        for (const word of ["markup", "margin", "per million", "M tokens", "%"]) expect(html).not.toContain(word)
        // Only purchase prices appear in dollars: no dollar value of credits and no model prices.
        for (const amount of html.match(/\$[\d.,]+/g) ?? []) expect(["$10", "$50", "$100", "$200"]).toContain(amount)
        expect(html).not.toMatch(/\d[\d,]* (Codium )?credits/)
      }
    }
  })

  test("questions are independent toggles: the first starts open, the rest closed and inert", () => {
    const html = render(live)
    const buttons = [...html.matchAll(/aria-expanded="(true|false)" aria-controls="([^"]+)"/g)]
    expect(buttons.map((match) => match[1])).toEqual(["true", "false", "false", "false", "false"])
    for (const match of buttons) expect(html).toContain(`id="${match[2]}"`)
    expect(html).toContain('<div class="cx-faq-answer" id="cx-faq-run-out" data-open="true">')
    expect(html).toContain('<div class="cx-faq-answer" id="cx-faq-balance" data-open="false" inert="">')
    expect(
      [...html.matchAll(/<h3><button[^>]*><span>(.*?)<\/span>/g)].map((match) => match[1]!.replace(/&#x27;/g, "'")),
    ).toEqual([
      "What happens when my credits run out?",
      "Where can I see my balance?",
      "How do Codium credits work?",
      "How can I make my credits last longer?",
      "Which models are included, and where do my requests go?",
    ])
    // Plus while closed, minus while open.
    expect(html.match(/lucide-minus/g)).toHaveLength(1)
    expect(html.match(/lucide-plus/g)).toHaveLength(4)
    const answers = text(html)
    expect(answers).toContain(
      "Use DeepSeek V4.1 Flash or Xiaomi MiMo V2.6 Flash for routine work and save Claude Haiku 5.5",
    )
    expect(answers).toContain("no overage charges and no automatic top-ups")
    for (const model of live.models ?? []) expect(html).toContain(`<strong>${model.name}</strong>`)
    expect(html).toContain('On your <a href="/account">account page</a>')
    expect(html).toContain('<a href="/legal/privacy">privacy policy</a>')
    expect(answers).toContain("route them only to zero-data-retention endpoints")
  })

  test("headings step down one level at a time below the page title", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const levels = [...render(config, mode).matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]))
      // The page's own h1 sits above this island, so the island starts at h2.
      expect(levels[0]).toBe(2)
      for (const [index, level] of levels.entries())
        if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
    }
  })

  test("with sales switched off every button says Coming soon and stays disabled", () => {
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
      expect(html.match(/<button class="cx-button" type="button" disabled="">Coming soon<\/button>/g)).toHaveLength(2)
      expect(html).not.toContain("Get Codium")
      expect(html).not.toContain("top-up<svg")
    }
    // A plan that reports itself available still waits while the product as a whole is off.
    expect(render({ ...config, enabled: false })).not.toContain("Get Codium 10")
    expect(render(live)).toContain("Coming soon")
    const open = render(config)
    expect(open).not.toContain("Coming soon")
    expect(open).not.toContain("disabled")
  })

  test("/pricing sends visitors to the Codium page, which the deploy keeps", async () => {
    const vercel = await Bun.file(new URL("../../../../../../vercel.json", import.meta.url)).json()
    expect(vercel.redirects).toContainEqual({ source: "/pricing", destination: "/codium", permanent: false })
    expect(await Bun.file(new URL("../../../../../../script/prune-vector-site.mjs", import.meta.url)).text()).toContain(
      '"codium"',
    )
  })
})
