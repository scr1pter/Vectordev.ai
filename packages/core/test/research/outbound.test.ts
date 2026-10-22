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
    expect(ResearchOutbound.rare("Budget 2,815,640; phone (415) 555-0134; card 4242 4242 4242 4242")).toEqual(
      expect.arrayContaining(["2815640", "4155550134", "4242424242424242"]),
    )
    // Values in a list, versions, IP addresses, spans of years and round numbers are not grouped numbers.
    const plain = ResearchOutbound.rare("Years 2024,2025,2026, Node 22.11.0, 1.99.110, 2024-2026, 4,000,000 users")
    expect(plain.filter((token) => /^\d+$/.test(token))).toEqual([])
    const typed = { ...context, typed: ["Who owns the line +1 415 555 0134? The budget is 2 815 640."] }
    expect(check("415-555-0134 owner", typed).ok).toBe(true)
    expect(check("2,815,640 budget", typed).ok).toBe(true)
    expect(check("4242 4242 4242 4242", typed).ok).toBe(false)
    // A public page listing the number does not clear it.
    expect(check("415-555-0134 owner", { ...context, public: ["Call 415-555-0134 for help."] }).ok).toBe(false)
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
