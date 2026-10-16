import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { publicModelPlans } from "../../../../../../api/_lib/model-plan-config"
import { codiumPricing } from "../../../lib/codium-pricing"
import { readModelPlanConfig, type ModelPlanConfig } from "../../../lib/model-plans"
import { CodiumPricing, CodiumQuestions, codiumMode, codiumModeUrl, type CodiumMode } from "./CodiumPricing"

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
// The deployed configuration contains only precomputed coarse estimates.
const live = readModelPlanConfig(publicModelPlans())
// The deployed configuration with sales switched on, as it will be at launch.
const selling: ModelPlanConfig = {
  ...live,
  enabled: true,
  plans: live.plans.map((plan) => ({ ...plan, available: true })),
  topups: live.topups?.map((pack) => ({ ...pack, available: true })),
}
const closed = (value: ModelPlanConfig): ModelPlanConfig => ({
  ...value,
  enabled: false,
  plans: value.plans.map((plan) => ({ ...plan, available: false })),
  topups: value.topups?.map((pack) => ({ ...pack, available: false })),
})

const render = (value: ModelPlanConfig, mode?: CodiumMode) =>
  renderToStaticMarkup(createElement(CodiumPricing, { pricing: codiumPricing(value), mode }))
const questions = (value: ModelPlanConfig) =>
  renderToStaticMarkup(createElement(CodiumQuestions, { models: codiumPricing(value).models }))
// One part of the island's markup: a tab's panel, or the comparison table.
const part = (html: string, name: "monthly" | "topup" | "compare") => {
  const starts = {
    monthly: html.indexOf('<div class="cx-panel" data-mode="monthly">'),
    topup: html.indexOf('<div class="cx-panel" data-mode="topup">'),
    compare: html.indexOf('<section class="cx-compare"'),
  }
  const ends = { monthly: starts.topup, topup: html.indexOf('<p class="cx-note'), compare: html.length }
  return html.slice(starts[name], ends[name])
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
const cards = (html: string) => html.split('<article class="cx-card">').slice(1)
const page = () => Bun.file(new URL("../../../pages/codium.astro", import.meta.url)).text()

describe("Codium pricing page", () => {
  test("both tabs render before hydration, and the tab from the address is chosen before the page paints", async () => {
    const html = render(selling)
    expect(cards(part(html, "monthly"))).toHaveLength(4)
    expect(cards(part(html, "topup"))).toHaveLength(2)
    const source = await page()
    expect(source.indexOf("root.dataset.codiumMode")).toBeLessThan(source.indexOf('<div class="cx-page">'))
    expect(source).toContain("<CodiumPricing client:load")
    expect(source).toContain("<CodiumQuestions client:load")
  })

  test("offers exactly the four monthly plans, with no free card, and highlights Codium 50", () => {
    const monthly = part(render(selling), "monthly")
    expect(live.plans.map((plan) => plan.price)).toEqual([10, 50, 100, 200])
    const plans = cards(monthly)
    expect(plans).toHaveLength(4)
    for (const [index, plan] of live.plans.entries()) {
      expect(plans[index]).toContain(`<h3 class="cx-type-md">Codium ${plan.price}</h3>`)
      expect(plans[index]).toContain(
        `<span class="cx-amount cx-type-lg">$${plan.price}</span><span class="cx-per">/month</span>`,
      )
      expect(plans[index]).toContain(`>Get Codium ${plan.price}</button>`)
    }
    // One plan carries the badge and the light button; the others use the dark one.
    expect(monthly.match(/Most popular/g)).toHaveLength(1)
    expect(plans[1]).toContain('<span class="cx-badge cx-type-xs">Most popular</span>')
    expect(plans[1]).toContain('<button class="cx-btn" type="button">Get Codium 50</button>')
    for (const index of [0, 2, 3]) expect(plans[index]).toContain('class="cx-btn cx-btn--secondary"')
    expect(monthly).not.toContain(">Free<")
    expect(monthly).not.toContain("$0")
    expect(monthly).not.toMatch(/Codium 20(?!0)/)
  })

  test("the first plan lists what every plan includes; later plans state their usage as a multiple and a range", () => {
    const plans = cards(part(render(live), "monthly")).map(text)
    expect(plans[0]).toContain("Get started with: Codium credits for every Codium model, every month")
    expect(plans[0]).toContain(
      "Models DeepSeek V4.1 Flash Xiaomi MiMo V2.6 Flash Claude Haiku 5.5 Zero-data-retention endpoints",
    )
    expect(plans[0]).toContain("In Vector No provider keys needed Works in the desktop app and CLI")
    for (const [index, multiple] of [5, 10, 20].entries()) {
      expect(plans[index + 1]).toContain(`Everything in Codium 10, and: ${multiple}x more usage than Codium 10`)
      expect(plans[index + 1]).toContain("Typical tasks a month")
    }
    expect(plans[3]).toContain(
      "DeepSeek V4.1 Flash: 1,000–10,000 Xiaomi MiMo V2.6 Flash: 1,600–16,000 Claude Haiku 5.5: 600–6,000",
    )
    // A model without a reviewed range gets no line.
    const sample = cards(part(render(config), "monthly")).map(text)
    expect(sample[1]).toContain("Everyday Coder: 300–2,700")
    expect(sample[1]).not.toContain("Hard Coder:")
  })

  test("the top-ups tab pairs one top-up card, with a picker for the four amounts, and a card for the plans", () => {
    const topups = part(render(selling, "topup"), "topup")
    expect(live.topups?.map((pack) => pack.price)).toEqual([10, 50, 100, 200])
    const [pack, plans] = cards(topups)
    expect(pack).toContain('<fieldset class="cx-seg cx-picker" aria-label="Top-up amount">')
    // Each amount is a radio named as checkout names it, so a top-up never shares a plan's name.
    for (const [index, item] of (live.topups ?? []).entries()) {
      expect(item.name).toBe(`Codium ${item.price} top-up`)
      expect(pack).toContain(
        `aria-label="${item.name}" name="cx-topup"${index === 0 ? ' checked=""' : ""} value="${index}"/>`,
      )
      expect(pack).toContain(`<span>$${item.price}</span>`)
    }
    expect(pack).toContain('<span class="cx-amount cx-type-lg">$10</span><span class="cx-per">one-time</span>')
    expect(pack).toContain('<button class="cx-btn" type="button">Buy Codium 10 top-up</button>')
    expect(text(pack)).toContain("Codium credits that carry forward, with no subscription")
    expect(text(pack)).toContain("DeepSeek V4.1 Flash: 50–500 tasks")
    expect(text(pack)).toContain("Unused credits carry forward")
    expect(text(pack)).not.toMatch(/never expire|no expiration|expiry/i)
    expect(plans).toContain('<span class="cx-amount cx-type-lg">$10–$200</span><span class="cx-per">/month</span>')
    expect(plans).toContain('<button class="cx-btn cx-btn--secondary" type="button">Compare plans</button>')
    expect(text(plans)).toContain("Up to 20x the usage of Codium 10")
  })

  test("the plan type is a native radio group, so it has one tab stop and arrow keys move between the tabs", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const html = render(config, mode)
      expect(html).toContain('<fieldset class="cx-seg cx-toggle" aria-label="Plan type">')
      const radios = [...html.matchAll(/<label data-value="(?:monthly|topup)">(<input [^>]*>)<span>(.*?)<\/span>/g)]
      expect(radios.map((match) => match[2])).toEqual(["Individual", "Top-ups"])
      for (const match of radios) expect(match[1]).toContain('type="radio" name="cx-plan-type"')
      expect(radios.map((match) => match[1]!.includes('checked=""'))).toEqual(
        mode === "monthly" ? [true, false] : [false, true],
      )
    }
    expect(render({ ...config, topups: undefined })).not.toContain('aria-label="Plan type"')
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

  test("renewal terms sit in every plan card and in the note under the cards", async () => {
    const html = render(config)
    for (const plan of cards(part(html, "monthly")))
      expect(plan).toContain("*Renews monthly until you cancel. Credits reset each billing period.")
    const note = text(html.slice(html.indexOf('<p class="cx-note')))
    expect(note).toContain("Plans renew monthly at the listed price until you cancel")
    expect(note).toContain("unused top-up credits carry forward separately from your subscription")
    expect(note).toContain("Any applicable taxes are shown before payment")
    expect(html).toContain('<a href="/legal/terms#codium">Codium terms</a>')
    expect(html.indexOf('<p class="cx-note')).toBeGreaterThan(html.lastIndexOf("<article"))
    const terms = await Bun.file(new URL("../../../pages/legal/terms.astro", import.meta.url)).text()
    expect(terms).toContain("renew automatically at the")
    expect(terms).toContain("carry forward separately from your subscription")
    expect(terms).toContain("Any applicable")
  })

  test("the comparison table has a column per plan and rows for usage, models, typical tasks and the workspace", () => {
    const table = part(render(live), "compare")
    expect(table).toContain('<h2 class="cx-type-lg" id="cx-compare-heading">Compare features across plans</h2>')
    const columns = [...table.matchAll(/<th scope="col">(.*?)<\/th>/g)].map((match) => text(match[1]!).trim())
    expect(columns).toEqual([
      "Feature",
      "Codium 10 $10 /month Coming soon",
      "Codium 50 $50 /month Coming soon",
      "Codium 100 $100 /month Coming soon",
      "Codium 200 $200 /month Coming soon",
    ])
    const groups = [...table.matchAll(/<th class="cx-compare-group"[^>]*><div>.*?<\/svg>(.*?)<\/div>/g)].map(
      (match) => match[1],
    )
    expect(groups).toEqual(["Models", "Typical tasks a month", "Credits", "Included in the free Vector workspace"])
    const rows = new Map(
      [...table.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((match) => [
        match[1]!,
        [...match[2]!.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => text(cell[1]!).trim()),
      ]),
    )
    expect(rows.get("Usage")).toEqual(["Base", "5x Codium 10", "10x Codium 10", "20x Codium 10"])
    expect(rows.get("DeepSeek V4.1 Flash (default)")).toEqual(Array(4).fill("Included"))
    expect(rows.get("Claude Haiku 5.5")).toEqual(["30–300", "150–1,500", "300–3,000", "600–6,000"])
    for (const feature of [
      "Parallel agents",
      "Vectorscope code reviews",
      "Vector Cloud",
      "Any provider with your own key",
    ])
      expect(rows.get(feature)).toEqual(Array(4).fill("Included"))
    expect(rows.get("Top-ups when credits run low")).toEqual(Array(4).fill("Included"))
    // A model without a reviewed range shows a dash for every plan.
    const sample = part(render(config), "compare")
    expect(sample).toContain('<tr><th scope="row">Hard Coder</th><td><span class="cx-mark cx-mark--no cx-type-md">—')
  })

  test("the launch catalog publishes coarse estimates without private assumptions", () => {
    expect(codiumPricing(live).monthly.every((offer) => offer.tasks.every((tasks) => tasks !== null))).toBe(true)
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
    for (const value of [config, live, selling]) {
      const pricing = codiumPricing(value)
      for (const offer of [...pricing.monthly, ...pricing.topups])
        expect(Object.keys(offer).sort()).toEqual(["available", "id", "multiple", "name", "price", "tasks"])
      for (const model of pricing.models)
        expect(Object.keys(model).every((key) => ["id", "name", "category", "description"].includes(key))).toBe(true)
      const props = JSON.stringify(pricing)
      for (const key of ["credits", "inputPrice", "outputPrice", "contextLength"])
        expect(props).not.toContain(`"${key}"`)
      for (const mode of ["monthly", "topup"] as const) {
        const html = render(value, mode) + questions(value)
        for (const word of ["markup", "margin", "per million", "M tokens", "%"]) expect(html).not.toContain(word)
        // Only purchase prices appear in dollars: no dollar value of credits and no model prices.
        for (const amount of html.match(/\$[\d.,]+/g) ?? []) expect(["$10", "$50", "$100", "$200"]).toContain(amount)
        expect(html).not.toMatch(/\d[\d,]* (Codium )?credits/)
      }
    }
  })

  test("questions are independent toggles that all start closed", () => {
    const html = questions(live)
    expect(html).toContain('<h2 class="cx-type-lg" id="cx-faq-heading">Questions &amp; Answers</h2>')
    const buttons = [...html.matchAll(/id="(cx-faq-q-[^"]+)" aria-expanded="(true|false)" aria-controls="([^"]+)"/g)]
    expect(buttons).toHaveLength(9)
    for (const match of buttons) {
      expect(match[2]).toBe("false")
      expect(html).toContain(`id="${match[3]}" role="region" aria-labelledby="${match[1]}"`)
    }
    expect(html.match(/data-state="closed"/g)).toHaveLength(9)
    expect([...html.matchAll(/aria-controls="[^"]+">(.*?)<svg/g)].map((match) => text(match[1]!).trim())).toEqual([
      "What is the right plan for me?",
      "Do I need Codium to use Vector?",
      "How do Codium credits work?",
      "What happens when my credits run out?",
      "Which models are included, and where do my requests go?",
      "Are prices inclusive of taxes?",
      "Where can I see my balance?",
      "How can I make my credits last longer?",
      "Can I cancel any time?",
    ])
    const answers = text(html)
    expect(answers).toContain(
      "Use DeepSeek V4.1 Flash or Xiaomi MiMo V2.6 Flash for routine work and save Claude Haiku 5.5",
    )
    expect(answers).toContain("no overage charges and no automatic top-ups")
    expect(answers).toContain("route them only to zero-data-retention endpoints")
    for (const model of live.models ?? []) expect(html).toContain(`<strong>${model.name}</strong>`)
    expect(html).toContain('<a href="/account">account page</a>')
    expect(html).toContain('<a href="/legal/privacy">privacy policy</a>')
  })

  test("headings step down one level at a time below the page title", () => {
    for (const mode of ["monthly", "topup"] as const) {
      const levels = [...(render(config, mode) + questions(config)).matchAll(/<h([1-6])[\s>]/g)].map((match) =>
        Number(match[1]),
      )
      // The page's own h1 sits above the islands, so they start at h2.
      expect(levels[0]).toBe(2)
      for (const [index, level] of levels.entries())
        if (index > 0) expect(level - levels[index - 1]!).toBeLessThanOrEqual(1)
    }
  })

  test("with sales switched off every buy button says Coming soon, stays disabled and keeps its size", () => {
    for (const value of [config, live]) {
      const html = render(closed(value))
      const buys = [...html.matchAll(/<button class="(cx-btn[^"]*)" type="button"( disabled="")?>(.*?)<\/button>/g)]
      // Card buttons and table buttons for each plan, the top-up card's button, and the switch to the plans.
      expect(buys).toHaveLength(value.plans.length * 2 + 2)
      for (const match of buys.filter((item) => item[3] !== "Compare plans")) {
        expect(match[2]).toBe(' disabled=""')
        expect(match[3]).toBe("Coming soon")
      }
      // The same classes as when sales are on, so the same size; only the table's buttons are small.
      const open = [...render(value).matchAll(/<button class="(cx-btn[^"]*)"/g)].map((match) => match[1])
      expect(buys.map((match) => match[1])).toEqual(open)
      expect(html).toContain('<button class="cx-btn cx-btn--secondary" type="button">Compare plans</button>')
      expect(html).not.toContain("Get Codium")
      expect(html).not.toContain("Buy Codium")
    }
    // A plan that reports itself available still waits while the product as a whole is off.
    expect(render({ ...config, enabled: false })).not.toContain("Get Codium 10")
    expect(render(live)).toContain("Coming soon")
    const open = render(config)
    expect(open).not.toContain("Coming soon")
    expect(open).not.toContain("disabled")
  })

  test("the page keeps Vector's own chrome: its logo, links, sign in, download and footer", async () => {
    const source = await page()
    expect(source).toContain('<a class="cx-logo" href="/" aria-label="Vector home">')
    for (const link of ['["Docs", "/docs"]', '["Changelog", "/docs/changelog"]', '["Codium", "/codium"]'])
      expect(source).toContain(link)
    expect(source).toContain('<a class="cx-signin" href="/login">Sign in</a>')
    expect(source).toContain('<a class="cx-btn cx-btn--sm cx-download" href="/download">Download</a>')
    expect(source).toContain("Get started with Vector.")
    expect([...source.matchAll(/title: "(\w+)"/g)].map((match) => match[1])).toEqual([
      "Product",
      "Resources",
      "Features",
      "Legal",
      "Platforms",
    ])
    // The page's typeface is scoped to /codium; the rest of the site keeps its own.
    const css = await Bun.file(new URL("./codium-pricing.css", import.meta.url)).text()
    expect(css).toContain(".cx-page {\n  --cx-sec")
    expect(css.match(/font-family:/g)).toHaveLength(1)
  })

  test("/pricing sends visitors to the Codium page, which the deploy keeps", async () => {
    const vercel = await Bun.file(new URL("../../../../../../vercel.json", import.meta.url)).json()
    expect(vercel.redirects).toContainEqual({ source: "/pricing", destination: "/codium", permanent: false })
    expect(await Bun.file(new URL("../../../../../../script/prune-vector-site.mjs", import.meta.url)).text()).toContain(
      '"codium"',
    )
  })
})
