import { describe, expect, test } from "bun:test"
import { ResearchOutbound } from "../../src/research/outbound"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

// What a research lead might hold: recalled personal lines and a private document passage (private facts), and a
// repository file it read (the work). The secret-shaped values are built at run time so this file holds none, and
// invisible characters are built from their code points so this file shows every character it tests.
const char = (...codes: number[]) => String.fromCodePoint(...codes)
const context: ResearchOutbound.Context = {
  private: [
    "Krishna prefers primary sources and is preparing the Falcon account renewal for Acme Robotics.",
    "Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change, according to the internal board memo dated 12 August.",
    "Krishna's daughter goes to Lincoln Elementary in Fremont.",
    "Jane's phone is 415-555-0134, and the Q3 budget is 2,815,640 dollars.",
    "The company card is 4242 4242 4242 4242. SSN 078-05-1120 is on the onboarding form.",
    "We drop GLOBEX in Q3. Codename ZEPHYR ships in March.",
    // Memory-of-you lines as the brain keeps personal facts: short, subject first, a label and its value.
    "Initech is the user's employer.",
    "Employer: Globex.",
    "Kestrel ships before the Q4 board meeting.",
    "Umbrella pays about 2,400,000 USD a year.",
    // Figures as documents write them, with their digits in groups.
    "Annual revenue was $12,345,678 last year and payroll is 2.345.678 EUR.",
    "The renewal goes on the card 4417880256719113.",
    // The numbers a memory-of-you line holds, written the ways people write them.
    "My phone number is +1 415-555-0132.",
    "SSN: 123-45-6789",
    "Account 0044 0532 0130 at First Bank.",
    "Home phone 415.555.0177",
  ],
  work: [
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
  // Identifiers, host names and email addresses split into words, one for each part.
  ["reconcile ledger entries", "token"],
  ["reconcile_ledger_entries", "token"],
  ["settle partner payouts", "token"],
  ["billing acme internal io invoices", "token"],
  ["jane doe acme robotics example", "token"],
  // Numbers however their digits are grouped: a phone, an amount, a card and an SSN.
  ["415-555-0134", "token"],
  ["call 415 555 0134", "token"],
  ["4155550134", "token"],
  ["555-0134 owner", "token"],
  ["2,815,640 budget", "token"],
  ["2815640", "token"],
  ["2 815 640 grant", "token"],
  ["4242 4242 4242 4242", "token"],
  ["4242424242424242", "token"],
  ["078-05-1120", "token"],
  ["078 05 1120", "token"],
  ["4,417,203 refund", "token"],
  // Names in capitals.
  ["GLOBEX churn", "token"],
  ["globex contract", "token"],
  ["ZEPHYR launch date", "token"],
  // Numbers written with their digits in groups, either side: the private text's 2,400,000 and 2.345.678, the
  // private 4417203 written 4,417,203 or 4 417 203, and a card number written in fours.
  ["2,400,000 USD", "token"],
  ["2400000 USD", "token"],
  ["$12,345,678 revenue", "token"],
  ["12,345,678", "token"],
  ["12345678", "token"],
  ["2.345.678 EUR payroll", "token"],
  [`2${char(0xa0)}345${char(0xa0)}678 payroll`, "token"],
  ["2'400'000 contract", "token"],
  ["$2,400,000.00 contract", "token"],
  ["24,00,000 USD", "token"],
  ["4,417,203 refund", "token"],
  ["4 417 203", "token"],
  ["4417 8802 5671 9113", "token"],
  ["4417-8802-5671-9113 renewal", "token"],
  // The same numbers with other separators, a currency code run into them, or the digits of other scripts:
  // Arabic-Indic, Devanagari and Extended Arabic-Indic.
  ["2-400-000", "token"],
  ["2\t400\t000", "token"],
  ["2  400  000", "token"],
  ["2, 400, 000", "token"],
  ["USD2,400,000", "token"],
  [`${char(0x662, 0x664, 0x660, 0x660, 0x660, 0x660, 0x660)} USD`, "token"],
  [`${char(0x968, 0x96a, 0x966, 0x966, 0x966, 0x966, 0x966)} USD`, "token"],
  [`${char(0x6f4, 0x6f4, 0x6f1, 0x6f7, 0x6f2, 0x6f0, 0x6f3)} refund`, "token"],
  ["4417 203", "token"],
  ["4417.8802.5671.9113", "token"],
  ["4417_8802_5671_9113", "token"],
  ["4417/8802/5671/9113", "token"],
  ["4417  8802  5671  9113", "token"],
  // Phone, social security and account numbers, whole, in parts, with and without a country code.
  ["415-555-0132 reverse lookup", "token"],
  ["who owns 415 555 0132", "token"],
  ["+1 415-555-0132", "token"],
  ["(415) 555-0132", "token"],
  ["4155550132", "token"],
  ["123-45-6789 credit check", "token"],
  ["123 45 6789", "token"],
  ["0044 0532 0130", "token"],
  ["004405320130", "token"],
  ["0532 0130", "token"],
  ["415.555.0177", "token"],
  ["4155550177", "token"],
  // Names that open a memory-of-you line, or follow its label.
  ["Initech procurement", "token"],
  ["Globex procurement", "token"],
  ["Kestrel launch", "token"],
  ["Umbrella contract value", "token"],
  // Look-alike letters from other scripts, small capitals and accents over the letters.
  [`${char(0x410)}cme churn`, "token"],
  [`Acm${char(0x435)} churn`, "token"],
  [`${char(0x391)}cme renewal`, "token"],
  [`${char(0x1d00, 0x1d04, 0x1d0d, 0x1d07)} renewal`, "token"],
  [`A${char(0x301)}cme renewal`, "token"],
  [`K${char(0x435)}strel launch`, "token"],
  [`F${char(0x430)}lcon pricing change`, "words"],
  [`the F${char(0x430)}lcon account renewal`, "words"],
  // Whole look-alike alphabets (Cherokee, Lisu, Coptic), a Myanmar zero, a Latin iota and a slashed o.
  [`${char(0x13aa)}cme churn`, "token"],
  [`${char(0xa4ee)}cme churn`, "token"],
  [`Ac${char(0x2c98)}e churn`, "token"],
  [`Gl${char(0x2c9f)}bex`, "token"],
  [`Gl${char(0x1040)}bex`, "token"],
  [`In${char(0x269)}tech procurement`, "token"],
  [`Gl${char(0xf8)}bex`, "token"],
  // ASCII's own look-alikes: a capital I for l, a zero for o, rn for m, vv for w, and a plural.
  ["GIobex pricing", "token"],
  ["GI0bex", "token"],
  ["Acrne churn", "token"],
  ["Initech Fremont vvorkshop", "token"],
  ["Acmes churn", "token"],
  ["reconciIeLedgerEntries", "token"],
]

// Queries a research agent writes for public questions, some on the same subjects as the private context. At most
// two may be refused: the check matches literal overlap, and this set measures how often that stops a fair query.
// The numbered ones below are measured apart, since numbers written side by side read as one.
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

// Fair queries with numbers in them: standards, years side by side, spans of years, versions and a quarter.
const numbered = [
  "iso 9001 2015",
  "heat pumps 2019 2024",
  "SaaS churn Q3 2026",
  "ISO 14001 certification cost",
  "EN 14511 heat pump test conditions",
  "IEC 60335-2-40 refrigerant charge limits",
  "ASHRAE 90.1 2022 heat pump efficiency",
  "top 10 heat pumps 2025",
  "R32 versus R290 heat pumps",
  "Node 22.11.0 release notes",
  "heat pump sales 2024 2025",
  "CVE-2024-3094 xz backdoor",
  "tax brackets 2024-2025",
  "best laptops 2025 2026",
  "heat pump incentives 2024 2025",
  "UK tax year 2024-25 rates",
]

// A data file of numbers only, as a repository's fixtures and exports hold them: a row number, a year, a count, a
// rate and an amount of up to 5 digits on each row, the values joined by `separator`.
const dataFile = (rows: number, separator: string) =>
  [
    ["id", "year", "units", "rate", "amount"].join(separator),
    ...Array.from({ length: rows }, (_, index) =>
      [
        index + 1,
        2015 + (index % 10),
        (index * 37) % 1000,
        `${(index * 13) % 97}.${index % 10}`,
        (index * 7919) % 100_000,
      ].join(separator),
    ),
  ].join("\n")

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
    // Measured on 22 Oct 2026, with names and 3-word runs from prose: 0 of 50, and still 0 with the memory-of-you
    // lines, grouped figures and look-alike folding added, and with phone, social security and account numbers,
    // numbers read by their digits and Unicode's look-alikes added. With nothing typed, 3 of 50 are refused, all for
    // "robotics", which "Acme Robotics" makes a name.
    expect(refused).toEqual([])
  })

  test("refuses none of the fair queries with numbers in them", () => {
    // Measured on 22 Oct 2026: 0 of 16.
    expect(numbered.filter((query) => !check(query).ok)).toEqual([])
  })

  test("reads a private number glued to its currency, or in another script's digits, either way round", () => {
    const cases = [
      ["Umbrella pays USD2,400,000 a year.", "2,400,000 USD"],
      ["Umbrella pays USD2,400,000 a year.", "2400000"],
      ["Payroll is EUR2.345.678.", "2345678"],
      ["Payroll is EUR2.345.678.", "2,345,678 EUR"],
      [`Umbrella pays ${char(0x662, 0x66c, 0x664, 0x660, 0x660, 0x66c, 0x660, 0x660, 0x660)} USD.`, "2400000"],
      [`Umbrella pays ${char(0x662, 0x66c, 0x664, 0x660, 0x660, 0x66c, 0x660, 0x660, 0x660)} USD.`, "2,400,000 USD"],
      ["Call (415) 555-0132 after six.", "+1 415 555 0132"],
    ] as const
    for (const [line, query] of cases)
      expect({ line, query, ok: check(query, { private: [line], typed: [], public: [] }).ok }).toEqual({
        line,
        query,
        ok: false,
      })
  })

  test("reads a query's digits whatever stands between them, words included", () => {
    const umbrella = {
      private: [
        "Umbrella pays about 2,400,000 USD a year.",
        "Order 4417203 was refunded.",
        "Her employee number is 58213.",
      ],
      typed: [],
      public: [],
    }
    const queries = [
      // Separators of any length or kind, line breaks, and modifier letters used as apostrophes.
      "2    400    000 USD",
      "2 -- 400 -- 000",
      "2 . . 400 . . 000",
      "2\n400\n000",
      `2${char(0x2bc)}400${char(0x2bc)}000`,
      `2${char(0x2c8)}400${char(0x2c8)}000`,
      // Digits one by one, regrouped, with letters between them, or across words.
      "4 4 1 7 2 0 3",
      "44172 03",
      "4417x203",
      "a4b4c1d7e2f0g3",
      "4417 and 203",
      "4417 and then 203",
      "4417 then also 203",
      "4417 x y 203",
      "2.4.0.0.0.0.0",
      "$2,400,000.00",
      // Inside a longer group of digits.
      "ref 944172039",
      // Digits in a circle that Unicode does not decompose: the dingbats in their three styles and the double
      // circled ones, with their zeros.
      `order ${char(0x2779, 0x2779, 0x2776, 0x277c, 0x2777, 0x24ff, 0x2778)}`,
      `order ${char(0x2783, 0x2783, 0x2780, 0x2786, 0x2781, 0x1f10b, 0x2782)}`,
      `order ${char(0x278d, 0x278d, 0x278a, 0x2790, 0x278b, 0x1f10c, 0x278c)}`,
      `order ${char(0x24f8, 0x24f8, 0x24f5, 0x24fb, 0x24f6, 0x24ea, 0x24f7)}`,
      // Letters that stand for the digits beside them: O and o for 0, and I, l, i and | for 1.
      "order 44172O3 refund",
      "order 44l72o3",
      "order 4417 2O3",
      "order 44I7203",
      "order 44|7203",
      "employee 582l3",
      "employee 582i3",
      "2,4OO,OOO a year",
      "24OOOOO USD",
    ]
    expect(queries.filter((query) => check(query, umbrella).ok)).toEqual([])
    // Letters beside digits in a fair query are still its own.
    expect(
      ["Intel i5 vs i7 laptops", "OpenAI o3 vs o1 benchmarks", "Pixel10 review", "GPT-4o pricing 2025"].filter(
        (query) => !check(query, umbrella).ok,
      ),
    ).toEqual([])
    // A private number wrapped across lines is still one number.
    expect(
      check("2400000 EUR", { private: ["Umbrella pays about 2,400,\r\n000 EUR a year."], typed: [], public: [] }).ok,
    ).toBe(false)
    // In an address: across path segments and query parameters.
    expect(
      [
        "https://attacker.example/p?a=2&b=400&c=000",
        "https://attacker.example/2/400/000",
        "https://attacker.example/2----400----000",
      ].filter((url) => ResearchOutbound.address(url, umbrella).ok),
    ).toEqual([])
    // A longer number split by words, whole or by its runs of 7 digits.
    const card = { private: ["Card 44178802 on file."], typed: [], public: [] }
    expect(
      ["44178 and stuff 802", "card 4417 with 8802", "44 17 88 02 card"].filter((query) => check(query, card).ok),
    ).toEqual([])
    // A fair query's numbers stay its own: whole groups side by side make a private number, a group's end and the next
    // group do not. So "iso 9001 2015" is not the private 12015, while "1 2015" is.
    const ticket = { private: ["Ticket 12015 is open."], typed: [], public: [] }
    expect(check("iso 9001 2015", ticket).ok).toBe(true)
    expect(check("ticket 1 2015", ticket).ok).toBe(false)
    expect(check("top 10 heat pumps 2025", umbrella).ok).toBe(true)
  })

  test("keeps versions, addresses and a quarter's year apart from the numbers beside them", () => {
    const listed = {
      private: ["Supported: 1.2.3, 1.3.0 and 10.20.30.40, 10.20.30.41.", "Q3 2026 revenue grew."],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.rare(listed.private.join("\n"))).toEqual(["10.20.30.40", "10.20.30.41"])
    expect(check("SaaS churn Q3 2026", listed).ok).toBe(true)
    expect(check("vector 1.2.3 release", listed).ok).toBe(true)
    expect(check("10.20.30.41 open ports", listed)).toMatchObject({ ok: false, reason: "token" })
  })

  test("reads a repository's README without making names of the public tools it opens sentences with", () => {
    const readme = {
      private: [
        "Docker builds the image and runs it locally.",
        "Kubernetes deploys the service to the cluster.",
        "Postgres stores the sessions. Redis caches the rate limits.",
        "Vite serves the app in development, and Vitest runs the tests.",
        "Nginx terminates TLS in front of the Python workers.",
        "Our partner is Globex Industries.",
      ],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.names(readme.private)).toEqual(["globex", "industries"])
    const tools = [
      "docker compose healthcheck",
      "kubernetes readiness probe timeout",
      "postgres connection pooling",
      "redis rate limiting lua script",
      "vite proxy websocket",
      "vitest mock timers",
      "nginx tls termination config",
      "python worker memory leak",
    ]
    // Measured on 22 Oct 2026: 0 of 8. Before the tools were listed, all 8 were refused.
    expect(tools.filter((query) => !check(query, readme).ok)).toEqual([])
    expect(check("Globex pricing", readme)).toMatchObject({ ok: false, reason: "token" })
  })

  test("checks a query once its full-width letters are folded", () => {
    expect(check("ｒｅｃｏｎｃｉｌｅLedgerEntries").ok).toBe(false)
  })

  test("lets only the user's typing clear a rare token or a name, never a public page", () => {
    const listed = {
      ...context,
      public: [...context.public, "Tickets jira.acme.internal and Acme are listed here."],
    }
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

  test("reads a name that opens a sentence or follows a label, and not a common word there", () => {
    expect(
      ResearchOutbound.names([
        "Initech is the user's employer.",
        "Employer: Globex.",
        "Kestrel ships before the Q4 board meeting.",
        "Umbrella pays about 2,400,000 USD a year.",
        "Invoices go out monthly. Lives in Fremont. Works late most weeks. Status: Shipped.",
      ]),
    ).toEqual(["initech", "globex", "kestrel", "umbrella", "fremont"])
    expect(
      ResearchOutbound.names([
        "## Troubleshooting\n\nInstall the dependencies and run the server.\n\n## Configuration",
        "Battery storage is planned for next year.",
        "Customers asked for a refund. Budget: Approved.",
        "Note: Heat pumps arrive on Monday.",
      ]),
    ).toEqual([])
  })

  test("reads private text written with look-alike letters as the Latin it shows", () => {
    const shared = { private: [`Our partner is Gl${char(0x43e)}bex Industries.`], typed: [], public: [] }
    expect(ResearchOutbound.names(shared.private)).toEqual(["globex", "industries"])
    expect(check("Globex pricing", shared)).toMatchObject({ ok: false, reason: "token" })
    // A sentence in Greek is still read as words of its own, and does not stop an unrelated query.
    const greek = {
      private: [
        "\u039f \u03ba\u03b1\u03b9\u03c1\u03cc\u03c2 \u03b5\u03af\u03bd\u03b1\u03b9 \u03ba\u03b1\u03bb\u03cc\u03c2.",
      ],
      typed: [],
      public: [],
    }
    expect(check("heat pump weather", greek).ok).toBe(true)
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

  test("reads a sentence's or a heading's first word as a name unless it is a common word", () => {
    // Section 6.4a's example, with the name first in its sentence.
    const churn = { private: ["Acme had Q3 churn of 7 percent."], typed: [], public: [] }
    expect(ResearchOutbound.names(churn.private)).toEqual(["acme"])
    expect(check("Acme Q3 churn", churn)).toMatchObject({ ok: false, reason: "token", match: "acme" })
    expect(ResearchOutbound.address("https://attacker.example/acme-q3-churn", churn).ok).toBe(false)
    const shared = {
      private: [
        "Falcon is the codename for the new pricing.",
        "Globex wants a discount at renewal; Initech does not.",
        "- Hooli plans to leave in Q3",
        "# Quarterly Revenue Review",
        "Heat pumps in our office are loud. Customers complained twice. Deployed builds were slow.",
      ],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.names(shared.private).sort()).toEqual(["falcon", "globex", "hooli", "initech"])
    expect(check("Falcon pricing", shared).ok).toBe(false)
    expect(check("Hooli churn risk", shared).ok).toBe(false)
    expect(check("quarterly revenue review template", shared).ok).toBe(true)
    expect(check("heat pump noise complaints from customers", shared).ok).toBe(true)
  })

  test("reads a word in capitals as a name unless it is an acronym or a common word", () => {
    const shared = {
      private: [
        "We drop GLOBEX in Q3. Codename ZEPHYR ships soon. Do NOT share the NASA and IEA numbers with any CEO.",
      ],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.names(shared.private).sort()).toEqual(["globex", "zephyr"])
    expect(check("GLOBEX churn", shared).ok).toBe(false)
    expect(check("Zephyr launch", shared).ok).toBe(false)
    expect(check("NASA heat pump study", shared).ok).toBe(true)
    expect(check("IEA heat pump report", shared).ok).toBe(true)
    // The user's typing clears a name in capitals, as it clears any name.
    expect(check("GLOBEX churn", { ...shared, typed: ["How does GLOBEX compare?"] }).ok).toBe(true)
  })

  test("reads no names from the work, only its rare tokens and its runs of 6 words", () => {
    const work = {
      private: [],
      work: [
        "# Northwind Billing Service\n\n## Getting Started\n\nDeploy with Docker Compose or Kubernetes.",
        "Use Tailwind for styles. Call reconcileLedgerEntries from the worker on build01.corp.lan.",
      ],
      typed: [],
      public: [],
    }
    expect(check("Tailwind CSS v4 theme variables", work).ok).toBe(true)
    expect(check("getting started with Kubernetes", work).ok).toBe(true)
    expect(check("Docker Compose healthcheck", work).ok).toBe(true)
    expect(ResearchOutbound.address("https://kubernetes.io/docs/getting-started/", work).ok).toBe(true)
    expect(check("reconcileLedgerEntries retries", work).ok).toBe(false)
    expect(check("build01.corp.lan uptime", work).ok).toBe(false)
    expect(check("call reconcileLedgerEntries from the worker on", work).ok).toBe(false)
  })

  test("treats import, export and type lines, fenced code and source files as code", () => {
    const code = [
      'export * as ResearchWords from "./words"',
      'import Billing from "./billing"',
      "export type Ledger = Billing.Entry",
      "declare module Payouts",
      "from ledger import Reconciler",
    ]
    expect(code.flatMap((line) => ResearchOutbound.names([line]))).toEqual([])
    expect(
      ResearchOutbound.names([
        "Notes on the export.\n\n```ts\nconst Ledger: Payouts\n  Reconciler,\n```\n\nGlobex pays late.",
      ]),
    ).toEqual(["globex"])
    // A source file's lines that are not caught one by one (keys, union members) are code too.
    const source = [
      "export const Settings = Schema.Struct({",
      "  Ledger: Schema.String,",
      "  Payouts: Schema.Number,",
      "})",
      "export type Status =",
      "  | Pending",
      "  | Settled",
      "export function settle(order: number) {",
      "  return order",
      "}",
    ].join("\n")
    expect(ResearchOutbound.names([source])).toEqual([])
  })

  test("compares numbers by their digits, so separators do not hide one, and lets the user's own digits through", () => {
    const budget = {
      private: ["Budget 2,815,640; phone (415) 555-0134; card 4242 4242 4242 4242"],
      typed: [],
      public: [],
    }
    expect(["2815640", "4155550134", "4242424242424242"].filter((query) => check(query, budget).ok)).toEqual([])
    // Values in a list, versions, IP addresses, spans of years and round numbers are not numbers.
    const plain = {
      private: [
        "Years 2024,2025,2026, Node 22.11.0, 1.99.110, 2024-2026, 4,000,000 users",
        "Years 2024, 2025. Node 22.11.0, then 1.99.110 on 10.20.30.40, for 4,000,000 users",
      ],
      typed: [],
      public: [],
    }
    const values = ["20242025", "2024 2025 2026", "20252026", "22110", "199110", "20242026", "4000000"]
    expect(values.filter((query) => !check(query, plain).ok)).toEqual([])
    const typed = { ...context, typed: ["Who owns the line +1 415 555 0134? The budget is 2 815 640."] }
    expect(check("415-555-0134 owner", typed).ok).toBe(true)
    expect(check("2,815,640 budget", typed).ok).toBe(true)
    expect(check("4242 4242 4242 4242", typed).ok).toBe(false)
    // A public source in the run that holds the number as one of its own clears it, as the user's typing does, read by
    // its digits as well. A page that holds more than 100 numbers clears none: it could list every number of a length.
    expect(check("2,815,640 budget", { ...context, public: ["A grant of 2 815 640 dollars."] }).ok).toBe(true)
    // It clears that number only: 415-555-0134 still shares seven digits in a row with the private 415-555-0132.
    expect(check("415-555-0134 owner", { ...context, public: ["Call (415) 555 0134 for help."] })).toMatchObject({
      ok: false,
      match: "4155550",
    })
    expect(
      check("order 4417203 refund", { ...context, public: ["Tickets 4,417,203 and 9,000,111 are open."] }).ok,
    ).toBe(true)
    const listing = Array.from({ length: 101 }, (_, index) => String(4417150 + index)).join(", ")
    expect(check("order 4417203 refund", { ...context, public: [listing.replaceAll(", ", "\n")] }).ok).toBe(false)
    // Nor does a page that holds it only inside another number, or as digits that do not stand as a number of its own.
    expect(check("415-555-0134 owner", { ...context, public: ["Ref 9415555013477."] }).ok).toBe(false)
    // Unrelated numbers next to each other in a query are not a private one.
    expect(check("heat pump sales 2025 2026 forecast", context).ok).toBe(true)
    expect(check("Node 22.11.0 release notes", context).ok).toBe(true)
  })

  test("matches an identifier split into words only with one word for each part", () => {
    const work = {
      private: [],
      work: ["const statusCode = await reconcileLedgerEntries(OpenAIResponses.create(jira_ticket_url))"],
      typed: [],
      public: [],
    }
    expect(check("reconcile ledger entries", work).ok).toBe(false)
    expect(check("Reconcile-Ledger-Entries", work).ok).toBe(false)
    expect(check("jira ticket url", work).ok).toBe(false)
    expect(check("HTTP status code 429 meaning", work).ok).toBe(true)
    expect(check("OpenAI responses API", work).ok).toBe(true)
    expect(
      check("reconcile ledger entries", { ...work, typed: ["Why does reconcileLedgerEntries refund twice?"] }).ok,
    ).toBe(true)
  })

  test("lets a domain the user prefers or avoids through as a host name, and nothing else", () => {
    const preferred = {
      private: ["Acme's analysts publish on acme-robotics.com."],
      work: ["Prefer primary sources such as nature.com and nejm.org; avoid ads.example.com."],
      typed: [],
      public: [],
      domains: ["nature.com", "NEJM.org", "www.ads.example.com", "jira.acme.internal"],
    }
    expect(check("heat pumps site:nature.com", preferred).ok).toBe(true)
    expect(check("www.nature.com heat pump field study", preferred).ok).toBe(true)
    expect(check("nejm.org heat pump trial", preferred).ok).toBe(true)
    expect(check("ads.example.com tracking", preferred).ok).toBe(true)
    expect(check("heat pumps site:nature.com", { ...preferred, domains: [] })).toMatchObject({
      ok: false,
      reason: "token",
      match: "nature.com",
    })
    // The domains clear host names only: not a name, a run of words or an intranet host.
    expect(check("acme-robotics.com", { ...preferred, domains: ["acme-robotics.com"] }).ok).toBe(false)
    expect(
      check("jira.acme.internal outage", {
        ...preferred,
        work: [...preferred.work, "Tickets live on jira.acme.internal."],
      }).ok,
    ).toBe(false)
  })

  test("refuses few fair queries against a realistic repository context", () => {
    // A README with title-case headings and a table, AGENTS.md-style rules, how-you-work lines, and a few private
    // facts, as a research lead in a repository would hold them.
    const repository: ResearchOutbound.Context = {
      private: [
        "Krishna's company is Acme Robotics; its Q3 churn was 7.4 percent.",
        "Falcon is the codename for the new pricing.",
        "We decided to move Hooli to annual invoices in March.",
      ],
      work: [
        [
          "# Northwind Billing Service",
          "",
          "Northwind Billing turns Stripe events into invoices, refunds and payouts.",
          "",
          "## Getting Started",
          "",
          "Install the dependencies with `bun install`, then run `bun dev`. Open the Admin Console at the address it prints.",
          "",
          "## Configuration Guide",
          "",
          "Set `DATABASE_URL` and `STRIPE_KEY` in `.env`. Webhooks Retry Automatically after a timeout.",
          "",
          "| Setting | Default | Notes |",
          "|---|---|---|",
          "| Retry Limit | 5 | Per Webhook Event |",
          "",
          "## Deployment Guide",
          "",
          "Deploy with Docker Compose or Kubernetes. The Helm Chart lives in `deploy/helm`.",
          "",
          "## Troubleshooting",
        ].join("\n"),
        [
          "## Style Guide",
          "",
          "- Use Bun APIs when possible, like `Bun.file()`.",
          "- In Effect generators, bind services to named variables before calling methods.",
          "- Prefer Effect schema helpers such as `Schema.decodeUnknownOption` over manual `JSON.parse`.",
          "- Keep Drizzle tables in snake_case, and run migrations from packages/db.",
          "- Use Tailwind CSS v4 theme variables and SolidJS signals in the app.",
          "- Tests cannot run from the repository root; run them from a package directory.",
        ].join("\n"),
        "Prefers Bun over Node for scripts, and Effect for services.",
        "Likes answers as tables, with primary sources first.",
        "Uses SolidJS and Tailwind for the app; avoid React examples.",
        "Prefer primary sources such as nature.com and nejm.org.",
      ],
      typed: ["How do other agent harnesses sandbox shell commands on macOS?"],
      public: [],
      domains: ["nature.com", "nejm.org"],
    }
    const queries = [
      "macOS sandbox-exec seatbelt profiles for agents",
      "agent harness sandboxing on macOS",
      "Bun test runner isolate flag",
      "Bun file API",
      "Effect services and layers",
      "Effect schema decodeUnknownOption",
      "Electron utilityProcess sandbox",
      "SolidJS signals performance",
      "Tailwind CSS v4 theme variables",
      "Docker sandbox for coding agents",
      "Docker Compose healthcheck",
      "Kubernetes deployment guide",
      "getting started with Kubernetes",
      "Helm chart best practices",
      "OpenRouter free models rate limits",
      "GitHub Actions macOS runners",
      "Drizzle ORM sqlite migrations",
      "Drizzle snake_case column names",
      "TypeScript incremental builds",
      "Apple seatbelt deprecated",
      "Landlock Linux sandbox",
      "Windows AppContainer sandbox",
      "Stripe webhook retry limit",
      "invoice refund idempotency keys",
      "admin console design patterns",
      "SaaS churn benchmarks 2026",
      "annual invoicing versus monthly billing",
      "primary sources on heat pumps site:nature.com",
      "nejm.org heat pump trial",
      "configuration guide examples for open source services",
    ]
    const urls = [
      "https://kubernetes.io/docs/getting-started/",
      "https://docs.docker.com/compose/",
      "https://helm.sh/docs/chart_best_practices/",
      "https://bun.sh/docs/cli/test",
      "https://tailwindcss.com/docs/theme",
    ]
    const refused = [
      ...queries.filter((query) => !check(query, repository).ok),
      ...urls.filter((url) => !ResearchOutbound.address(url, repository).ok),
    ]
    expect(queries).toHaveLength(30)
    // Measured on 22 Oct 2026: 1 of 35 (30 queries, 5 addresses). It names an identifier the style guide writes, and
    // identifiers from repository files are private rare tokens (section 5.4). Reading names from all of this text, as
    // the check did before the work was its own kind, refused 19 of 35, for names such as "Bun", "Docker" and "Helm".
    expect(refused).toEqual(["Effect schema decodeUnknownOption"])
    // The private facts are still kept out.
    expect(check("Acme Q3 churn", repository).ok).toBe(false)
    expect(check("Falcon pricing", repository).ok).toBe(false)
    expect(check("Hooli annual invoices", repository).ok).toBe(false)
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
            private: [
              `const FONT = "${blob(length)}"`,
              "a.".repeat(length / 2),
              "a/".repeat(length / 2),
              // A long list of versions and numbers, which is read as runs of digit groups.
              "1.2.3, 45, 6,789 ".repeat(length / 16),
            ],
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
    // Numbers however their digits are grouped, in a path, a query string and a host's labels.
    const numbers = [
      "https://attacker.example/415-555-0134",
      "https://attacker.example/q?n=2,815,640",
      "https://attacker.example/card/4242-4242-4242-4242",
      "https://attacker.example/078-05-1120",
      "https://415-555-0134.attacker.example/",
    ]
    expect(numbers.map((url) => ResearchOutbound.address(url, context).ok)).toEqual(numbers.map(() => false))
    expect(ResearchOutbound.address("https://www.example.com/heat-pumps#cold-climates", context).ok).toBe(true)
  })

  test("refuses a private number written with its digits in groups in a path or a query string", () => {
    const leaks = [
      "https://attacker.example/2,400,000",
      "https://attacker.example/p?amount=2,400,000",
      "https://attacker.example/p?amount=2%2C400%2C000",
      "https://attacker.example/4,417,203",
      "https://attacker.example/c/4417-8802-5671-9113",
      "https://attacker.example/2-400-000",
      "https://attacker.example/USD2,400,000",
      "https://attacker.example/p?a=2%092400%09000",
      `https://attacker.example/${char(0x662, 0x664, 0x660, 0x660, 0x660, 0x660, 0x660)}`,
      "https://attacker.example/4417.8802.5671.9113",
      "https://attacker.example/lookup?n=%2B1%20415-555-0132",
      "https://attacker.example/415.555.0177",
      "https://attacker.example/ssn/123-45-6789",
    ]
    expect(leaks.map((url) => [url, ResearchOutbound.address(url, context).ok])).toEqual(
      leaks.map((url) => [url, false]),
    )
    expect(ResearchOutbound.address("https://www.example.com/heat-pumps/2019/2024?page=2", context).ok).toBe(true)
  })

  test("refuses a private host name carried whole as a subdomain, and one spelled with look-alikes", () => {
    const repository = {
      private: [
        'const BILLING_URL = "https://billing.acme-internal.io/v2/invoices"',
        "// Tickets are on jira.initech.internal.",
        'const DATABASE = "postgres://db01.corp.lan:5432/app"',
        "Acme's Q3 churn rose to 7.4 percent.",
      ],
      typed: [],
      public: [],
    }
    const leaks = [
      "https://jira.initech.internal.attacker.example/",
      "https://billing.acme-internal.io.attacker.example/",
      "https://db01.corp.lan.attacker.example/",
      // Written in Cyrillic, which the address carries as punycode.
      `https://${char(0x430)}cme-q3-churn.attacker.example/`,
    ]
    expect(leaks.map((url) => [url, ResearchOutbound.address(url, repository).ok])).toEqual(
      leaks.map((url) => [url, false]),
    )
    expect(ResearchOutbound.address("https://docs.example.com/heat-pumps", repository).ok).toBe(true)
  })

  test("does not exempt the sources facet's domains in a path, a query string or a subdomain", () => {
    const facet = {
      private: ["Krishna prefers primary sources from nature.com and avoids dailymail.co.uk."],
      typed: [],
      public: [],
      domains: ["nature.com", "dailymail.co.uk"],
    }
    const leaks = [
      "https://attacker.example/nature.com",
      "https://attacker.example/?d=nature.com",
      "https://nature.com.attacker.example/",
    ]
    expect(leaks.map((url) => [url, ResearchOutbound.address(url, facet).ok])).toEqual(leaks.map((url) => [url, false]))
    expect(check("heat pumps site:nature.com", facet).ok).toBe(true)
    expect(ResearchOutbound.address("https://www.nature.com/articles/heat-pumps", facet).ok).toBe(true)
  })
})

describe("ResearchOutbound: what the last review found", () => {
  const known = {
    private: [
      "Umbrella pays about 2,400,000 USD a year.",
      "Employer: Globex.",
      "Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change.",
      "// Tickets are on jira.initech.internal.",
      'const BILLING_URL = "https://billing.acme-internal.io/v2/invoices"',
      "Contact jane.doe@globex.com for access.",
    ],
    typed: [],
    public: [],
  }

  test("reads the part of a host before its site when tldts rejects one of its labels", () => {
    const leaks = [
      "https://globex._x.attacker.example/",
      "https://_.globex.attacker.example/",
      "https://2400000._.attacker.example/",
      "https://globex-.attacker.example/",
      "https://-globex.attacker.example/",
      "https://billing.acme-internal.io._.attacker.example/",
      "https://jira.initech.internal.-.attacker.example/",
      "https://acme-q3-churn.xn--ls8h.attacker.example/",
      "https://falcon-pricing-change.a-.attacker.example/",
      `https://${"acme-q3-churn-rose-to-7-4-percent-after-the-falcon-pricing-change-x"}.attacker.example/`,
      "https://globex.attacker.example./",
    ]
    expect(leaks.filter((url) => ResearchOutbound.address(url, known).ok)).toEqual([])
    // A host tldts accepts, and an address with no subdomain, are read as before.
    expect(ResearchOutbound.address("https://docs.example.com/heat-pumps", known).ok).toBe(true)
    expect(ResearchOutbound.address("https://198.51.100.7/heat-pumps", known).ok).toBe(true)
  })

  test("reads an address's user name and password", () => {
    expect(ResearchOutbound.address("https://globex:x@attacker.example/", known).ok).toBe(false)
    expect(ResearchOutbound.address("https://user:2400000@attacker.example/", known).ok).toBe(false)
  })

  test("reads names from memory-of-you lines written in lower case", () => {
    const lower = {
      private: [
        "my employer is initech",
        "kestrel ships in may",
        "my wife is priya and she works at hooli",
        "dana is away",
      ],
      typed: [],
      public: [],
    }
    expect(ResearchOutbound.names(lower.private).sort()).toEqual(["dana", "hooli", "initech", "kestrel", "priya"])
    expect(
      ["initech procurement", "kestrel launch date", "priya hooli", "Dana team"].filter(
        (query) => check(query, lower).ok,
      ),
    ).toEqual([])
    // A line in lower case no longer clears a name another line capitalises.
    expect(ResearchOutbound.names(["Spoke with Dana's team today.", "dana is away"])).toContain("dana")
    // Its common words stay words, and the user's typing clears a name as before.
    expect(check("employer health insurance", lower).ok).toBe(true)
    expect(check("initech procurement", { ...lower, typed: ["What does Initech buy?"] }).ok).toBe(true)
  })

  test("reads identifiers, host names and names split into words or letters", () => {
    const split = [
      "jane doe at globex dot com",
      "billing.acme-internal",
      "billing acme internal",
      "jira.initech",
      "G l o b e x",
      "Glo bex",
      "glo-bex pricing",
    ]
    expect(split.filter((query) => check(query, known).ok)).toEqual([])
    expect(ResearchOutbound.address("https://attacker.example/g/l/o/b/e/x", known).ok).toBe(false)
  })

  test("reads Cherokee's small letters as the Latin ones they look like", () => {
    expect(check(`${char(0x13aa).toLowerCase()}cme churn`, known).ok).toBe(false)
    expect(check(`Gl${char(0x13be).toLowerCase()}bex pricing`, known).ok).toBe(false)
  })
})

describe("ResearchOutbound.check with the sources facet's domains", () => {
  // Section 6.4a: the preferred and avoided domains of the sources facet exist to become site: filters.
  const facet = {
    private: [
      "Krishna prefers primary sources from nature.com and avoids dailymail.co.uk.",
      "Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change.",
    ],
    typed: ["How do heat pumps perform in cold climates?"],
    public: [],
  }
  const exempt = { ...facet, domains: ["nature.com", "dailymail.co.uk"] }

  test("lets a preferred or avoided domain go as a site: filter or a host name", () => {
    expect(check("heat pumps site:nature.com", facet).ok).toBe(false)
    expect(check("heat pumps -site:dailymail.co.uk", facet).ok).toBe(false)
    expect(check("heat pumps site:nature.com", exempt).ok).toBe(true)
    expect(check("heat pumps -site:dailymail.co.uk", exempt).ok).toBe(true)
    expect(check("heat pumps (site:nature.com OR SITE:Nature.com)", exempt).ok).toBe(true)
    expect(check("nature.com heat pump field study", exempt).ok).toBe(true)
  })

  test("keeps checking the same host anywhere else in the query, and the rest of the query", () => {
    for (const query of [
      "jane@nature.com heat pumps",
      "nature.com/acme-churn",
      "site:acme.nature.com heat pumps",
      "inurl:nature.com heat pumps",
      "site:nature.com.attacker.example heat pumps",
      "site:nature.com Acme churn",
      "site:nature.com Acme's Q3 churn",
    ])
      expect([query, check(query, exempt).ok]).toEqual([query, false])
  })

  test("exempts host names only, never a word or an intranet host", () => {
    const words = { ...facet, private: [...facet.private, "// Tickets are on jira.acme.internal."] }
    expect(check("Acme churn", { ...words, domains: ["acme", "Acme"] }).ok).toBe(false)
    expect(check("site:jira.acme.internal", { ...words, domains: ["jira.acme.internal"] }).ok).toBe(false)
  })
})

describe("ResearchOutbound.rare", () => {
  test("finds identifiers, paths, email addresses, host names and IP addresses, and not common names or numbers", () => {
    const text =
      "Call reconcileLedgerEntries in src/billing/ledger.ts, mail ops@acme.example, see status.acme-robotics.com and jira.acme.internal, ticket 4417203, host 10.20.30.40, use GitHub and JavaScript, 10000 users, node.js, 127.0.0.1, and/or TCP/IP."
    const found = ResearchOutbound.rare(text)
    expect(found).toEqual(
      expect.arrayContaining([
        "reconcileLedgerEntries",
        "src/billing/ledger.ts",
        "ops@acme.example",
        "status.acme-robotics.com",
        "jira.acme.internal",
        "10.20.30.40",
      ]),
    )
    for (const common of ["node.js", "127.0.0.1", "GitHub", "JavaScript", "and/or", "TCP/IP"])
      expect(found).not.toContain(common)
    // Numbers are read by their digits, apart from the rare tokens: the ticket is private, a round number is not.
    expect(found.filter((token) => /^\d+$/.test(token))).toEqual([])
    const shared = { private: [text], typed: [], public: [] }
    expect(check("ticket 4417203", shared)).toMatchObject({ ok: false, reason: "token", match: "4417203" })
    expect(check("10000 users", shared).ok).toBe(true)
  })
})

describe("ResearchOutbound.check with private numbers", () => {
  test("reads a number written with its digits in groups as one number, and leaves versions and addresses", () => {
    const shared = {
      private: [
        "Revenue $12,345,678.50, payroll 2.345.678 EUR, 2 400 000 USD, 1,23,45,679 INR, card 4417-8802-5671-9113, 10,000 users, version 1.100.2, hosts 192.168.100.200 and 192.168.1.20.",
      ],
      typed: [],
      public: [],
    }
    const numbers = ["12345678", "2345678", "2400000", "12345679", "4417880256719113"]
    expect(numbers.filter((query) => check(query, shared).ok)).toEqual([])
    expect(check("10000 users", shared).ok).toBe(true)
    expect(check("version 11002", shared).ok).toBe(true)
    expect(ResearchOutbound.rare(shared.private[0]!)).toEqual(
      expect.arrayContaining(["192.168.100.200", "192.168.1.20"]),
    )
  })

  test("reads a number in any script's digits and with any separator, and the stretches of whole groups in it", () => {
    const shared = {
      private: [
        `Paid USD2,400,000 and ${char(0x662, 0x664, 0x660, 0x660, 0x660, 0x660, 0x660)}; call +1 (415) 555-0132.`,
      ],
      typed: [],
      public: [],
    }
    expect(["2400000", "14155550132", "4155550132", "5550132"].filter((query) => check(query, shared).ok)).toEqual([])
    // Digits that are not whole groups of it are not one of its numbers.
    expect(check("14155", shared).ok).toBe(true)
  })

  test("reads a span of years as years, and keeps the numbers beside it private", () => {
    const spans = {
      private: ["Plan for fiscal year 2025-2026.", "The FY2024-25 budget was 4,417,203; 2024-2025: 2,815,640 spent."],
      work: [
        "MIT License\n\nCopyright (c) 2024-2025 Northwind.\n\nPermission is hereby granted, free of charge, to any person.",
      ],
      typed: [],
      public: [],
    }
    const queries = [
      "heat pump incentives 2024 2025",
      "tax brackets 2024-2025",
      "heat pump trends 2024 2025 Europe",
      "best laptops 2025 2026",
      "UK tax year 2024-25 rates",
      "20242025",
    ]
    expect(queries.filter((query) => !check(query, spans).ok)).toEqual([])
    expect(["4417203", "2,815,640 spent", "budget 4 417 203"].filter((query) => check(query, spans).ok)).toEqual([])
  })

  test("reads a date written in numbers as a date, and keeps the numbers beside it private", () => {
    const dated = {
      private: [
        "Krishna joined Globex on 6/1/2025.",
        "The lease renews on 4/3/2026.",
        "Moved to Berlin on 1.6.2025, and the trip runs 12/18/25 to 1/2/26.",
        "Mom's birthday is 7/2/1958. The card expires 10/2025.",
        "Invoice 2025-10-20 4417203 is paid; 6/1/2025: 2,815,640 spent.",
      ],
      // A changelog dates every release.
      work: [
        "# Changelog\n\n## 1.4.0 - 2025-10-20\n- Faster startup.\n\n## 1.3.2 - 2025-09-14\n- Fixed login.\n\n## 1.3.0 - 2025.08.01\n- Dark mode.",
      ],
      typed: [],
      public: [],
    }
    const queries = [
      "Q1 2025 SaaS churn benchmarks",
      "Q2 2025 earnings",
      "Q3 2026 GPU prices",
      "Q4 2025 layoffs",
      "H1 2025 venture funding",
      "H2 2026 outlook",
      "top 1 2025 laptops",
      "3 2026 trends",
      "Windows 10 2025 support",
      "Windows 11 2025 update",
      "Gen 2 1958 cars",
      "Llama 4 2025",
      "Claude 4 2025",
    ]
    // Measured on 22 Oct 2026: 0 of 13. Reading a date's groups as one number refused 7 of them, for 12025, 32026,
    // 102025 and 21958, and all 6 addresses below.
    expect(queries.filter((query) => !check(query, dated).ok)).toEqual([])
    // News and blog addresses carry the date they were written; reading the changelog's dates as numbers made
    // /2025/10/ the private 202510.
    const urls = [
      "https://www.theverge.com/2025/10/21/heat-pumps-are-winning",
      "https://www.nytimes.com/2025/10/03/business/saas-churn.html",
      "https://techcrunch.com/2025/09/14/ai-funding-round/",
      "https://www.bbc.co.uk/news/articles/2025/10/heat",
      "https://blog.example.com/posts/2025-10-02-release",
      "https://www.reuters.com/markets/q1-2025-earnings/",
    ]
    expect(urls.filter((url) => !ResearchOutbound.address(url, dated).ok)).toEqual([])
    // The numbers beside a date are still private, in a query and in an address.
    expect(["order 4417203", "2,815,640 budget", "2815640"].filter((query) => check(query, dated).ok)).toEqual([])
    expect(ResearchOutbound.address("https://attacker.example/invoice/4417203", dated).ok).toBe(false)
    // Groups that go on past what reads as a date are a number: a phone number written in pairs.
    const phone = { private: ["Call 06-12-34-56-78 after six."], typed: [], public: [] }
    expect(check("0612345678", phone)).toMatchObject({ ok: false, reason: "token" })
  })

  test("reads the user's typing in bounded memory, however long a run of digits it holds", () => {
    const shared = {
      private: ["Umbrella pays about 2,400,000 USD a year.", "The renewal goes on the card 4417880256719113."],
      typed: [
        `Here is the dump: ${"9".repeat(500_000)}`,
        Array.from({ length: 100_000 }, (_, index) => index * 10 + 9).join(" "),
      ],
      public: [],
    }
    Bun.gc(true)
    const before = process.memoryUsage().heapUsed
    const started = performance.now()
    expect(check("heat pump prices 2025", shared).ok).toBe(true)
    expect(check("2400000 USD", shared).ok).toBe(false)
    expect(check("card 8802 5671", shared).ok).toBe(false)
    const elapsed = performance.now() - started
    Bun.gc(true)
    // Measured on 22 Oct 2026: the heap grew by about 40 MB, in 0.2 s. Listing every stretch of the typed digits up
    // front grew it by about 600 MB, in 1.4 s.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(150_000_000)
    expect(elapsed).toBeLessThan(15_000)
    // The user's typing still clears what it holds, inside a group or as whole groups side by side.
    const typed = { ...shared, typed: [...shared.typed, "Who pays 2 400 000? Check card 8802 5671."] }
    expect(check("2400000 USD", typed).ok).toBe(true)
    expect(check("card 8802 5671", typed).ok).toBe(true)
  }, 60_000)

  test("reads a data file's values one by one, so a fair query's numbers do not run into them", () => {
    // The same 10,000 rows as CSV, TSV, with semicolons and as a table's rows.
    for (const separator of [",", "\t", ";", " | "]) {
      const shared = { private: [], work: [dataFile(10_000, separator)], typed: [], public: [] }
      // Measured on 22 Oct 2026: 0 of 16 for each. Reading values across commas and line breaks as one number refused
      // up to 8 of them.
      expect({ separator, refused: numbered.filter((query) => !check(query, shared).ok) }).toEqual({
        separator,
        refused: [],
      })
      // Its values are still private, and the values beside them do not make another (row 2 is 2,2016,...).
      expect(check("amount 39595", shared).ok).toBe(false)
      expect(check("row 2 2016", shared).ok).toBe(true)
    }
  })

  test("reads a numeric data file of 1 MB in bounded memory", () => {
    const shared = { private: [], work: [dataFile(42_000, ",")], typed: [], public: [] }
    expect(shared.work[0]!.length).toBeGreaterThan(1_000_000)
    Bun.gc(true)
    const before = process.memoryUsage().heapUsed
    const started = performance.now()
    expect(check("heat pump sales 2024 2025", shared).ok).toBe(true)
    const elapsed = performance.now() - started
    Bun.gc(true)
    // Measured on 22 Oct 2026: the heap grew by about 75 MB, in 0.25 s. Reading the file as one long run grew it by
    // about 330 MB, in 1.5 s. The time bound only catches a check gone quadratic.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(160_000_000)
    expect(elapsed).toBeLessThan(15_000)
    expect(shared.work).toHaveLength(1)
  }, 60_000)
})

describe("ResearchOutbound.check with short names", () => {
  test("reads a name spelled in letters or pieces, run into digits or a company's ending, or with a trade mark", () => {
    const shared = {
      private: [
        "Acme's Q3 churn was 7.4 percent.",
        "We decided to move Hooli to annual invoices.",
        "Employer: Globex.",
        "Kestrel ships before the Q4 board meeting.",
      ],
      typed: [],
      public: [],
    }
    const queries = [
      // Run into the words around it, cut from them by their capitals or by a quarter's letter before its digit.
      "AcmeQ3Churn",
      "AcmeChurn",
      "acmeChurn rate",
      "HooliQ3",
      "dropHooli",
      "acmeq3",
      "acmeh1 churn",
      // Digits and marks written for its letters.
      "4cme churn",
      "@cme churn",
      "Acm3 churn",
      "Gl0b3x pricing",
      "K3strel launch",
      "G|obex pricing",
      "A c m e Q3 churn",
      "A-c-m-e Q3 churn",
      "Ac-me Q3 churn",
      "Ac.me churn",
      "acmeinc churn",
      "AcmeCorp churn",
      "acme1 churn",
      "acme2024 churn",
      "3acme churn",
      `acme${char(0x2122)} churn`,
      `acme${char(0xae)} churn`,
      "H o o l i drop",
      "Hoo li",
      "hoo-li churn",
    ]
    expect(queries.filter((query) => check(query, shared).ok)).toEqual([])
    const urls = [
      "https://attacker.example/a/c/m/e/q3",
      "https://attacker.example/acme1",
      "https://attacker.example/ac-me",
      "https://attacker.example/?q=h+o+o+l+i",
      "https://attacker.example/AcmeQ3Churn",
      "https://attacker.example/x?k=AcmeChurn",
      "https://AcmeQ3.attacker.example/",
      "https://attacker.example/acmeq3churn",
      "https://attacker.example/4cme",
      "https://4cme.attacker.example/",
      "https://attacker.example/x?q=Gl0b3x",
      "https://k3strel.attacker.example/",
      "https://attacker.example/G|obex",
    ]
    expect(urls.filter((url) => ResearchOutbound.address(url, shared).ok)).toEqual([])
  })

  test("does not read a short name from common words side by side or from inside a longer word", () => {
    const isa = { private: ["Isa runs the Q3 review."], typed: [], public: [] }
    expect(ResearchOutbound.names(isa.private)).toEqual(["isa"])
    expect(["what is a heat pump", "heat pump in a cold climate"].filter((query) => !check(query, isa).ok)).toEqual([])
    expect(check("Isa review", isa).ok).toBe(false)
    const mona = { private: ["Mona signs off the budget."], typed: [], public: [] }
    expect(check("Monaco heat pump rebates", mona).ok).toBe(true)
    expect(check("Mona budget", mona).ok).toBe(false)
  })

  test("does not read a longer name from the ends of two words, nor a short one from a name everyone uses", () => {
    const people = {
      private: [
        "Krishna lives in Austin with his partner Martin.",
        "Sandra from Globex owns the renewal.",
        "The team offsite is in Denver.",
        "We hired Kit and Lang last spring.",
      ],
      typed: [],
      public: [],
    }
    const fair = [
      "heat pump exhaust in cold climates",
      "car exhaust in winter",
      "smart insurance pricing models",
      "smart in home sensors",
      "thousand rabbits experiment",
      "best den vermin traps",
      "HomeKit API",
      "LangChain agents",
      // A digit beside a short word keeps its value ("5am" is not a private Sam).
      "flights at 5am",
    ]
    // Measured on 22 Oct 2026: 0 of 9. Matching a name anywhere in the query with its spaces taken out refused the
    // first 6, for Austin, Martin, Sandra and Denver.
    const sam = { ...people, private: [...people.private, "Sam and Leo review it."] }
    expect(fair.filter((query) => !check(query, sam).ok)).toEqual([])
    // A longer name is still read run into its word or made of whole words, and a short one as a word or a piece.
    const named = ["AustinTexas", "austin texas weather", "den ver", "Den-ver hail", "sand ra", "hireKit", "Kit budget"]
    expect(named.filter((query) => check(query, people).ok)).toEqual([])
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
