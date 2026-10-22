import { describe, expect, test } from "bun:test"
import { ResearchOutbound } from "../../src/research/outbound"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

// What a research lead might hold: recalled personal cards, a private document passage and repository files it read.
// The secret-shaped values are built at run time so this file holds none.
const context: ResearchOutbound.Context = {
  private: [
    "Krishna prefers primary sources and is preparing the Falcon account renewal for Acme Robotics.",
    "Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change, according to the internal board memo dated 12 August.",
    [
      'import { reconcileLedgerEntries } from "./ledger"',
      'const BILLING_URL = "https://billing.acme-internal.io/v2/invoices"',
      "// Ask jane.doe@acme-robotics.example for access to the ledger export.",
      'const LEDGER_PATH = "/srv/acme/ledger/2026-q3.csv"',
      "export function settle_partner_payouts(order: number) {",
      "  // Order 4417203 was refunded twice in September.",
      "  return reconcileLedgerEntries(order)",
      "}",
      '{ "name": "acme-billing", "dependencies": { "react": "19.1.0", "typescript": "5.9.2" } }',
    ].join("\n"),
  ],
  typed: ["Research how heat pumps perform in cold climates, and compare SaaS churn benchmarks for robotics companies."],
  public: ["A field study of air-source heat pumps in 412 homes. Median annual saving: 640 euros per home."],
}
const check = (query: string, using = context) => ResearchOutbound.check(query, using)

// Each of these sends private text, and each has to be refused.
const leaks: readonly (readonly [string, ResearchOutbound.Reason])[] = [
  ["Q3 churn rose to 7.4 percent after the Falcon pricing change", "words"],
  ["acme churn rose to 7.4 percent after pricing", "words"],
  ["after the falcon pricing change according to the internal board memo", "words"],
  ["reconcileLedgerEntries double refund bug", "token"],
  ["reconcileledgerentries", "token"],
  ["settle_partner_payouts implementation", "token"],
  ["billing.acme-internal.io invoices api", "token"],
  ["jane.doe@acme-robotics.example", "token"],
  ["/srv/acme/ledger/2026-q3.csv schema", "words"],
  ["ledger/2026-q3.csv columns", "token"],
  ["order 4417203 refund", "token"],
  ["my password is Tr0ub4dor&3x", "secret"],
  [`api key ${"AKIA"}${"IOSFODNN7EXAMPLE"}`, "secret"],
]

// Queries a research agent writes for public questions, some on the same subjects as the private context. At most
// two may be refused: the check matches literal overlap, and this set measures how often that stops a fair query.
const benign = [
  "heat pump performance in cold climates",
  "air source heat pump coefficient of performance below minus 15",
  "heat pump field study 412 homes",
  "median annual saving heat pump per home",
  "SaaS churn benchmarks for robotics companies",
  "average B2B SaaS churn rate 2026",
  "customer churn after a price increase study",
  "how to reduce churn after a pricing change",
  "robotics industry revenue growth 2025",
  "warehouse robotics market size",
  "primary sources on heat pump subsidies in the EU",
  "EU heat pump subsidy schemes by country",
  "IEA heat pump report 2025",
  "refrigerant R290 safety standards",
  "ground source versus air source heat pump cost",
  "heat pump noise regulations Germany",
  "React 19 server components performance",
  "TypeScript 5.9 release notes",
  "double entry bookkeeping ledger reconciliation best practices",
  "payment refund processing idempotency",
  "Stripe webhook retry behaviour",
  "invoice reconciliation automation tools",
  "board memo template for quarterly results",
  "what is net revenue retention",
  "gross margin benchmarks for hardware startups",
  "seasonal coefficient of performance definition",
  "cold climate heat pump specification NEEP",
  "oil boiler replacement grants UK",
  "smart meter data resolution fifteen minutes",
  "heat loss calculation method for houses",
  "insulation impact on heat pump savings",
  "district heating versus heat pumps",
  "heat pump installers shortage 2026",
  "compressor makers market share",
  "heat pump sales 2025 Europe",
  "battery storage paired with heat pumps",
  "time of use tariffs heat pumps",
  "heat pump efficiency at low temperatures research paper",
  "arxiv heat pump control reinforcement learning",
  "PubMed indoor air quality heat pumps",
  "wikipedia heat pump",
  "how do inverter compressors work",
  "defrost cycle energy loss air source heat pump",
  "hybrid heat pump systems evaluation",
  "Nordic heat pump adoption history",
  "Japan heat pump water heater market",
  "US Inflation Reduction Act heat pump rebates",
  "heat pump lifecycle carbon emissions",
  "SaaS pricing change case studies",
  "churn prediction models comparison",
]

describe("ResearchOutbound.check", () => {
  test("refuses every query in the leak set, for the reason it leaks", () => {
    const results = leaks.map(([query]) => check(query))
    expect(results.map((result) => (result.ok ? "allowed" : result.reason))).toEqual(leaks.map(([, reason]) => reason))
    expect(results.every((result) => !result.ok && result.message === ResearchOutbound.REFUSAL)).toBe(true)
  })

  test("allows the user's own words and words a public source in the run holds", () => {
    expect(check("SaaS churn benchmarks for robotics companies").ok).toBe(true)
    expect(check("A field study of air-source heat pumps in 412 homes").ok).toBe(true)
    // The same run of words is refused when only the private context has it, and allowed once the user typed it.
    const run = "rose to 7.4 percent after the Falcon pricing change"
    expect(check(run).ok).toBe(false)
    expect(check(run, { ...context, typed: [...context.typed, run] }).ok).toBe(true)
    // A rare token the user typed may be searched for.
    expect(check("reconcileLedgerEntries", { ...context, typed: ["why does reconcileLedgerEntries refund twice"] }).ok).toBe(
      true,
    )
  })

  test("needs at least two longer words in a run, so common phrases do not count", () => {
    const shared = { private: ["it is in the box of the year"], typed: [], public: [] }
    expect(check("it is in the box of the year", shared).ok).toBe(true)
  })

  test("refuses no more than two of 50 benign queries", () => {
    const refused = benign.filter((query) => !check(query).ok)
    expect(benign).toHaveLength(50)
    // Measured on 22 Oct 2026: 0 of 50.
    expect(refused).toEqual([])
  })

  test("checks a query once its full-width letters are folded", () => {
    expect(check("ｒｅｃｏｎｃｉｌｅLedgerEntries").ok).toBe(false)
  })
})

describe("ResearchOutbound.address", () => {
  test("checks an address's path and query, and a slug's words", () => {
    expect(ResearchOutbound.address("https://example.com/search?q=reconcileLedgerEntries", context).ok).toBe(false)
    expect(
      ResearchOutbound.address("https://example.com/q3-churn-rose-to-7-4-percent-after-the-falcon-pricing-change", context).ok,
    ).toBe(false)
    expect(ResearchOutbound.address("https://example.com/heat-pumps/cold-climates?page=2", context).ok).toBe(true)
  })
})

describe("ResearchOutbound.rare", () => {
  test("finds identifiers, paths, email addresses, host names and long numbers, and not common names", () => {
    const found = ResearchOutbound.rare(
      "Call reconcileLedgerEntries in src/billing/ledger.ts, mail ops@acme.example, see status.acme-robotics.com, ticket 4417203, use GitHub and JavaScript, 10000 users, and/or TCP/IP.",
    )
    expect(found).toEqual(
      expect.arrayContaining(["reconcileLedgerEntries", "src/billing/ledger.ts", "ops@acme.example", "status.acme-robotics.com", "4417203"]),
    )
    expect(found).not.toContain("GitHub")
    expect(found).not.toContain("JavaScript")
    expect(found).not.toContain("10000")
    expect(found).not.toContain("and/or")
    expect(found).not.toContain("TCP/IP")
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
