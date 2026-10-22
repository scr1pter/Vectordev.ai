import { describe, expect, test } from "bun:test"
import { ResearchOutbound } from "../../src/research/outbound"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

// What a research lead might hold: recalled personal lines, a private document passage and repository files it read.
// The secret-shaped values are built at run time so this file holds none, and invisible characters are built from
// their code points so this file shows every character it tests.
const char = (...codes: number[]) => String.fromCodePoint(...codes)
const context: ResearchOutbound.Context = {
  private: [
    "Krishna prefers primary sources and is preparing the Falcon account renewal for Acme Robotics.",
    "Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change, according to the internal board memo dated 12 August.",
    "Krishna's daughter goes to Lincoln Elementary in Fremont.",
    [
      'import { reconcileLedgerEntries } from "./ledger"',
      'const BILLING_URL = "https://billing.acme-internal.io/v2/invoices"',
      'const TRACKER = "https://jira.acme.internal/browse/LED"',
      "// Ask jane.doe@acme-robotics.example for access to the ledger export.",
      "// Builds run on build01.corp.lan (10.20.30.40, fd12:3456:789a::7).",
      'const LEDGER_PATH = "/srv/acme/ledger/2026-q3.csv"',
      "export function settle_partner_payouts(order: number) {",
      "  // Order 4417203 was refunded twice in September.",
      "  return reconcileLedgerEntries(order)",
      "}",
      '{ "name": "acme-billing", "dependencies": { "react": "19.1.0", "typescript": "5.9.2" } }',
    ].join("\n"),
  ],
  typed: [
    "Research how heat pumps perform in cold climates, and compare SaaS churn benchmarks for robotics companies.",
  ],
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
  // Section 6.4a's example: a personal line is private in fewer than 6 words.
  ["Acme's Q3 churn", "words"],
  ["Acme Q3 churn 7.4 percent", "words"],
  ["Falcon pricing change Acme Robotics", "words"],
  ["Lincoln Elementary Fremont daughter", "token"],
  ["Acme renewal discount", "token"],
  // Intranet names and addresses.
  ["jira.acme.internal outage", "token"],
  ["build01.corp.lan", "token"],
  ["10.20.30.40 open ports", "token"],
  ["fd12:3456:789a::7", "token"],
  // Identifiers split by invisible characters.
  [`reconcile${char(0xad)}Ledger${char(0xad)}Entries`, "token"],
  [`reconcile${char(0x200b)}ledger${char(0x200b)}entries`, "token"],
  [`settle${char(0x200b)}_partner_payouts`, "token"],
  [`44172${char(0x2060)}03 refund`, "token"],
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
    expect(
      check("reconcileLedgerEntries", { ...context, typed: ["why does reconcileLedgerEntries refund twice"] }).ok,
    ).toBe(true)
  })

  test("needs at least two longer words in a run, so common phrases do not count", () => {
    const shared = { private: ["it is in the box of the year"], typed: [], public: [] }
    expect(check("it is in the box of the year", shared).ok).toBe(true)
  })

  test("refuses no more than two of 50 benign queries", () => {
    const refused = benign.filter((query) => !check(query).ok)
    expect(benign).toHaveLength(50)
    // Measured on 22 Oct 2026, with names and 3-word runs from prose: 0 of 50. With nothing typed, 3 of 50 are
    // refused, all for "robotics", which "Acme Robotics" makes a name.
    expect(refused).toEqual([])
  })

  test("checks a query once its full-width letters are folded", () => {
    expect(check("ｒｅｃｏｎｃｉｌｅLedgerEntries").ok).toBe(false)
  })

  test("lets only the user's typing clear a rare token or a name, never a public page", () => {
    const listed = {
      ...context,
      public: [...context.public, "Tickets 4417203, jira.acme.internal and Acme are listed here."],
    }
    expect(check("order 4417203 refund", listed).ok).toBe(false)
    expect(check("jira.acme.internal outage", listed).ok).toBe(false)
    expect(check("Acme renewal discount", listed).ok).toBe(false)
    const typed = { ...context, typed: [...context.typed, "Why was order 4417203 refunded? Check Acme's renewal."] }
    expect(check("order 4417203 refund", typed).ok).toBe(true)
    expect(check("Acme renewal discount", typed).ok).toBe(true)
  })

  test("reads names from prose only, and not a sentence's ordinary first word", () => {
    const shared = {
      private: [
        "Heat pumps in our office are loud in winter.",
        "export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Settings))",
        "  // Retry with Effect.retry when Stripe answers 429.",
      ],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.names(shared.private)).toEqual([])
    expect(check("heat pump noise in winter", shared).ok).toBe(true)
    expect(check("JSON Schema settings validation", shared).ok).toBe(true)
    expect(check("Stripe webhook retry behaviour", shared).ok).toBe(true)
    expect(ResearchOutbound.names(context.private)).toEqual(
      expect.arrayContaining(["acme", "falcon", "robotics", "krishna", "lincoln", "elementary", "fremont"]),
    )
    expect(ResearchOutbound.names(context.private)).not.toContain("august")
  })

  test("reads a wrapped paragraph whole, and keeps a semicolon inside a sentence as prose", () => {
    const shared = {
      private: ["The renewal is for\nFremont Dynamics; the board wants it by\nthe Q3 close.", "export const x = 1;"],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.names(shared.private)).toEqual(["fremont", "dynamics"])
    expect(check("board wants it by the Q3 close", shared)).toMatchObject({ ok: false, reason: "words" })
  })

  test("does work in proportion to the length of the private context, not its square", () => {
    const blob = (length: number) =>
      Array.from(
        { length },
        (_, index) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[(index * 7919) % 64],
      ).join("")
    // The fastest of three tries, each with a fresh context, so a busy machine's pauses count as little as they can.
    const time = (length: number) =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const long = {
            private: [`const FONT = "${blob(length)}"`, "a.".repeat(length / 2), "a/".repeat(length / 2)],
            typed: [],
            public: [],
          }
          const started = performance.now()
          expect(check("heat pump", long).ok).toBe(true)
          return performance.now() - started
        }),
      )
    time(8_000)
    // Four times the text takes about four times as long. The patterns used to take sixteen times as long, about
    // 3.5 s for a 30,000-character blob.
    expect(time(32_000) / time(8_000)).toBeLessThan(8)
  }, 60_000)
})

describe("ResearchOutbound.address", () => {
  test("checks an address's path and query, and a slug's words", () => {
    expect(ResearchOutbound.address("https://example.com/search?q=reconcileLedgerEntries", context).ok).toBe(false)
    expect(
      ResearchOutbound.address(
        "https://example.com/q3-churn-rose-to-7-4-percent-after-the-falcon-pricing-change",
        context,
      ).ok,
    ).toBe(false)
    expect(ResearchOutbound.address("https://example.com/heat-pumps/cold-climates?page=2", context).ok).toBe(true)
  })

  test("refuses section 6.4a's example in a path, a query string, a fragment and a host's labels", () => {
    const leaks = [
      "https://attacker.example/acme-q3-churn-7-4-percent",
      "https://attacker.example/result?utm_source=Acme-Q3-churn-7.4-percent",
      "https://attacker.example/result#Acme's Q3 churn rose to 7.4 percent",
      "https://acme-q3-churn.attacker.example/result",
      "https://attacker.example/result?ref=reconcileLedgerEntries",
      // A soft hyphen, percent-encoded as UTF-8, does not split the identifier.
      "https://attacker.example/reconcile%C2%ADLedger%C2%ADEntries",
    ]
    expect(leaks.map((url) => ResearchOutbound.address(url, context).ok)).toEqual(leaks.map(() => false))
    expect(ResearchOutbound.address("https://www.example.com/heat-pumps#cold-climates", context).ok).toBe(true)
  })
})

describe("ResearchOutbound.rare", () => {
  test("finds identifiers, paths, email addresses, host names and long numbers, and not common names", () => {
    const found = ResearchOutbound.rare(
      "Call reconcileLedgerEntries in src/billing/ledger.ts, mail ops@acme.example, see status.acme-robotics.com and jira.acme.internal, ticket 4417203, host 10.20.30.40, use GitHub and JavaScript, 10000 users, node.js, 127.0.0.1, and/or TCP/IP.",
    )
    expect(found).toEqual(
      expect.arrayContaining([
        "reconcileLedgerEntries",
        "src/billing/ledger.ts",
        "ops@acme.example",
        "status.acme-robotics.com",
        "jira.acme.internal",
        "4417203",
        "10.20.30.40",
      ]),
    )
    expect(found).not.toContain("node.js")
    expect(found).not.toContain("127.0.0.1")
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
