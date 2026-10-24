import { describe, expect, test } from "bun:test"
import { ResearchOutbound } from "../../src/research/outbound"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

// What a research lead might hold: memory-of-you lines, decision and lesson lines and a private document passage (the
// private facts), and repository files it read (the work). They name people, companies, tools, versions, ports and
// public identifiers, which ordinary queries share and the check lets through, and contacts, intranet hosts and home
// folders, which it keeps out. The secret-shaped values are built at run time so this file holds none, and other
// scripts' characters are built from their code points so this file shows every character it tests.
const char = (...codes: number[]) => String.fromCodePoint(...codes)
// Digits written in Arabic-Indic digits.
const arabic = (digits: string) => char(...[...digits].map((digit) => 0x660 + Number(digit)))
const context: ResearchOutbound.Context = {
  private: [
    "Krishna prefers primary sources and is preparing the Falcon account renewal for Acme Robotics.",
    "Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change, according to the internal board memo dated 12 August.",
    "Notes from the call with Sandra, Victor, Albert, Cooper, Justin, Austin, George, Charles, Porter, Martin, Walter, Rainer and Archer.",
    "Decided to move billing to Stripe and the ORM to Prisma in March.",
    "Lesson: the Electron updater needs code signing on macOS. Pin Electron 33.2.0.",
    "We host the API on Railway now.",
    "Kestrel ships before the Q4 board meeting.",
    "We moved to annual billing in 2024, upgrade to Node 22 next, grew to 12 engineers, and keep reports in 2 pages.",
    "The servers run Ubuntu 22.04.4 and 24.04.1. QA pins Chrome 130.0.6723.91 and Chromium 128.0.6613.36 on Windows 10.0.19045 and 10.0.22631.4460.",
    "We need ISO 27001 2022 certification, patched CVE-2024-3094 and CVE-2024-12345, and cite arXiv 2410.12345 and doi 10.1038/s41586-021-03819-2.",
    "Jane's phone is 415-555-0134. My phone number is +1 (415) 555-0132, home phone 415.555.0177, and Paris 06 12 34 56 78.",
    "Email jane.doe@globex.com about the Initech contract.",
    "Account 0044 0532 0130 at First Bank. The company card is 4242 4242 4242 4242. SSN 078-05-1120.",
    "The renewal goes on the card 4417880256719113.",
    "Umbrella pays about 2,400,000 USD a year, and the Q3 budget is 2,815,640 dollars.",
    "Meeting notes 21/10/2025: follow up 2025/11/03. Invoice INV-2025-10-0042 was paid on 22 Oct 2025.",
  ],
  work: [
    [
      'import { reconcileLedgerEntries } from "./ledger"',
      'const BILLING_URL = "https://billing.acme-internal.io/v2/invoices"',
      'const TRACKER = "https://jira.acme.internal/browse/LED"',
      "// Ask ops@acme.com for access. Docs live on wiki.acme.com, builds on build01.corp.lan (10.20.30.40, fd12:3456:789a::7).",
      'const LEDGER_PATH = "/srv/acme/ledger/2026-q3.csv"',
      "// Order 4417203 was refunded twice in September.",
      "useEffect(() => setRows(useState(0)), []) // document.getElementById('x').querySelector('y') on x86_64",
      '{ "name": "acme-billing", "dependencies": { "react": "19.1.0", "typescript": "5.9.2" } }',
    ].join("\n"),
    "ollama listens on 11434, mongodb on 27017 and grpc on 50051. See vite issue 18234. nameserver = 8.8.8.8, gateway 192.168.1.1.",
    "Docs: https://docs.docker.com/compose/ and https://api.stripe.com/v1/charges. Copy .env.local, and read user.home.",
    "Root: /Users/kbharadwaj/Vectordev.ai. Payroll: C:\\Users\\kbharadwaj\\initech\\payroll-2025.xlsx",
  ],
  typed: [
    "Research how heat pumps perform in cold climates, and compare SaaS churn benchmarks for robotics companies.",
  ],
  public: ["A field study of air-source heat pumps in 412 homes. Median annual saving: 640 euros per home."],
}
const check = (query: string, using = context) => ResearchOutbound.check(query, using)
const address = (url: string, using = context) => ResearchOutbound.address(url, using)

// Each of these copies private text, and each has to be refused, for the reason it leaks.
const leaks: readonly (readonly [string, ResearchOutbound.Reason])[] = [
  // A secret.
  ["my password is Tr0ub4dor&3x", "secret"],
  [`api key ${"AKIA"}${"IOSFODNN7EXAMPLE"}`, "secret"],
  // 8 or more words of a memory line or a document, however they are written.
  ["Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change", "words"],
  ["acme q3 churn rose to 7 4 percent after", "words"],
  ["after the falcon pricing change according to the internal board memo", "words"],
  [`${char(0x410)}cme's Q3 churn rose to 7.4 percent after the F${char(0x430)}lcon pricing change`, "words"],
  [`preparing the Falcon account re${char(0xad)}newal for Acme Robo${char(0x200b)}tics`, "words"],
  ["reconcileLedgerEntries } from ledger const BILLING_URL https billing", "words"],
  // An email address from the private facts.
  ["jane.doe@globex.com", "token"],
  ["contact Jane.Doe@Globex.com about renewal", "token"],
  ["ｊａｎｅ．ｄｏｅ＠ｇｌｏｂｅｘ．ｃｏｍ", "token"],
  // A phone, card, account or social security number, however its digits are grouped.
  ["415-555-0134", "token"],
  ["call 415 555 0134", "token"],
  ["4155550134 owner", "token"],
  ["who owns +1 (415) 555-0132", "token"],
  ["415.555.0177 reverse lookup", "token"],
  ["06 12 34 56 78", "token"],
  ["0612345678", "token"],
  ["0044 0532 0130", "token"],
  ["account 004405320130", "token"],
  ["4242 4242 4242 4242", "token"],
  ["4242-4242-4242-4242", "token"],
  ["4417 8802 5671 9113", "token"],
  [`4417${char(0x2013)}8802${char(0x2013)}5671${char(0x2013)}9113`, "token"],
  [`4417${char(0xa0)}8802${char(0xa0)}5671${char(0xa0)}9113`, "token"],
  [`${arabic("4417880256719113")} renewal`, "token"],
  ["078-05-1120", "token"],
  ["078 05 1120 credit check", "token"],
  // A private host or IP address from the private context or the repository.
  ["jira.acme.internal outage", "token"],
  ["https://jira.acme.internal/browse/LED-12", "token"],
  ["build01.corp.lan", "token"],
  ["billing.acme-internal.io invoices api", "token"],
  ["wiki.acme.com search", "token"],
  ["10.20.30.40 open ports", "token"],
  ["fd12:3456:789a::7", "token"],
  [`jira.${char(0x430)}cme.internal`, "token"],
  // A local path in the home folder of the user the repository's root names, or with that user name in it.
  ["/Users/kbharadwaj/Vectordev.ai/notes.md", "token"],
  ["error in /users/KBharadwaj/Vectordev.ai/src/app.ts", "token"],
  ["C:\\Users\\kbharadwaj\\initech\\payroll-2025.xlsx", "token"],
  ["C:\\Users\\kbharadwaj ledger.db", "token"],
  ["/home/kbharadwaj/ledger.db", "token"],
  ["D:\\backup\\kbharadwaj\\ledger.db", "token"],
]

// Queries a research agent writes for public questions, many on the subjects the private context names. The last
// review found most of them refused, for a name, a look-alike, a 3-word run or a number. None may be.
const fair = [
  // Versions the private context holds.
  "Ubuntu 22.04.4 kernel regression",
  "Ubuntu 24.04.1 release notes",
  "Chrome 130.0.6723.91 crash",
  "Windows 10.0.19045 bug",
  "Windows build 22631 known issues",
  "Windows 10.0.22631.4460 update",
  "Chromium 128.0.6613.36 release notes",
  "Electron 33.2.0 release notes",
  // Words that hold or look like a name the private context holds.
  "Apache Cassandra tuning",
  "Victoria BC heat pump rebates",
  "victory gardens history",
  "Alberta carbon tax heat pumps",
  "energy cooperative heat pumps",
  "adjusting heat pump defrost settings",
  "just in time inventory systems",
  "exhausting the refrigerant charge",
  "Georgetown university energy study",
  "Charleston SC flood maps",
  "heat pump importers Europe",
  "supporters of the bill",
  "martingale betting system",
  "dust in heat pump filters",
  "heat pump researcher interviews",
  "best researchers on heat pumps",
  "waiter tipping etiquette",
  "personal trainer certification",
  // Tools a decision or lesson line names.
  "Stripe webhook retry behaviour",
  "Prisma vs Drizzle performance",
  "Electron autoUpdater code signing macOS",
  "Railway vs Fly.io pricing",
  // Short runs of a private line with a quarter, a year or a small number in them.
  "Q4 board meeting agenda template",
  "annual billing in 2024 trends",
  "upgrade to Node 22 breaking changes",
  "grew to 12 engineers startup",
  "reports in 2 pages executive summary",
  // Public identifiers, ports and issue numbers the private context or the repository holds.
  "CVE-2024-3094 xz backdoor",
  "CVE-2024-12345 exploit",
  "ISO 27001 certification cost",
  "ISO 27001 2022 certification requirements",
  "arXiv 2410.12345 results",
  "doi 10.1038/s41586-021-03819-2",
  "ollama 11434 connection refused docker",
  "mongodb 27017 connection refused",
  "grpc 50051 timeout",
  "vite issue 18234",
  // Public addresses and identifiers from code the repository holds.
  "8.8.8.8 DNS latency",
  "192.168.1.1 admin page not loading",
  "useEffect cleanup race condition",
  "React useState batching",
  "getElementById vs querySelector performance",
  "x86_64 vs arm64 performance",
  "api.stripe.com rate limits",
  "docs.docker.com compose healthcheck",
  ".env.local not loading in Next.js",
  "Java user.home property on Windows",
  // Dates, versions, years, quarters, prices and addresses everyone writes.
  "heat pump news 2025-10-20",
  "events on 14/11/2025 in Berlin",
  "SaaS churn Q3 2026",
  "heat pumps 2019 2024",
  "tax brackets 2024-2025",
  "UK tax year 2024-25 rates",
  "Node 22.11.0 release notes",
  "React 19.1.0 changelog",
  "Windows 11 24H2 update KB5044284",
  "speed of light 299,792,458 m/s",
  "zip codes 90001 to 90089",
  "localhost:3000 connection refused",
  "127.0.0.1 vs 0.0.0.0 binding",
  "169.254.169.254 metadata endpoint",
  "10.0.0.0/8 private address range",
  "~/.ssh/config ProxyJump example",
  "/etc/hosts file format",
  // The user's own words, and a long query of its own.
  "SaaS churn benchmarks for robotics companies",
  "how do air source heat pumps perform in very cold climates",
]

// Addresses of public pages on the same subjects.
const fairAddresses = [
  "https://releases.ubuntu.com/22.04.4/",
  "https://www.theverge.com/2025/10/21/heat-pumps-are-winning",
  "https://arxiv.org/abs/2410.12345",
  "https://www.nature.com/articles/s41586-021-03819-2",
  "https://nvd.nist.gov/vuln/detail/CVE-2024-3094",
  "https://docs.docker.com/compose/",
  "https://www.example.com/heat-pumps/2019/2024?page=2",
  "https://github.com/kbharadwaj/dotfiles",
]

// A data file of numbers only, as a repository's fixtures and exports hold them: a row number, a year, a count, a
// rate and an amount on each row, the values joined by `separator`.
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
    expect(results.map((result, index) => [leaks[index]![0], result.ok ? "allowed" : result.reason])).toEqual(
      leaks.map(([query, reason]) => [query, reason]),
    )
    expect(results.every((result) => !result.ok && result.message === ResearchOutbound.REFUSAL)).toBe(true)
  })

  test("refuses none of the fair queries and addresses against a rich private context", () => {
    expect(fair.filter((query) => !check(query).ok)).toEqual([])
    expect(fairAddresses.filter((url) => !address(url).ok)).toEqual([])
  })

  test("leaves names, amounts and short numbers to how a run is built, as section 5.4 decided", () => {
    // Names of people and companies, an amount and an order number from the private context go out: the check looks
    // for copying, and names and numbers like these are in ordinary queries all the time.
    const allowed = [
      "Acme Robotics competitors",
      "Acme Q3 churn",
      "Falcon pricing",
      "Initech procurement",
      "Kestrel launch",
      "Umbrella 2,400,000 USD contract",
      "2,815,640 budget",
      "order 4417203 refund",
      "reconcileLedgerEntries double refund bug",
    ]
    expect(allowed.filter((query) => !check(query).ok)).toEqual([])
  })

  test("needs 8 words in a row, not all of them common words", () => {
    expect(check("preparing the Falcon account renewal for Acme").ok).toBe(true)
    expect(check("is preparing the Falcon account renewal for Acme").ok).toBe(false)
    const plain = {
      private: ["Heat pumps are one of the best ways to cut the energy use at home."],
      typed: [],
      public: [],
    }
    expect(check("one of the best ways to cut the energy use", plain).ok).toBe(true)
  })

  test("lets the user's typing clear a run of words, a contact, a host and a home folder", () => {
    const queries = [
      "rose to 7.4 percent after the Falcon pricing change",
      "jane.doe@globex.com",
      "415-555-0134 owner",
      "jira.acme.internal outage",
      "/Users/kbharadwaj/Vectordev.ai/notes.md",
    ]
    expect(queries.filter((query) => check(query).ok)).toEqual([])
    const typed = {
      ...context,
      typed: [
        "Why has Acme's churn rose to 7.4 percent after the Falcon pricing change?",
        "Ask jane.doe@globex.com, or call +1 415 555 0134 and 415 555 0132.",
        "Is jira.acme.internal down? The notes are in /Users/kbharadwaj/Vectordev.ai.",
      ],
    }
    expect(queries.filter((query) => !check(query, typed).ok)).toEqual([])
  })

  test("lets a public source clear a run of words, an email address and a number, but not a host or a path", () => {
    const run = "the compressor makers plan to raise prices by nine percent"
    const article = { private: [`Members only: ${run} next spring.`], typed: [], public: [] }
    expect(check(run, article).ok).toBe(false)
    expect(check(run, { ...article, public: [`Trade press: ${run}.`] }).ok).toBe(true)
    const shown = {
      ...context,
      public: [
        "Contact jane.doe@globex.com. Ref 0044 0532 0130.",
        "Tickets jira.acme.internal and /Users/kbharadwaj/Vectordev.ai are listed here.",
      ],
    }
    expect(check("jane.doe@globex.com", shown).ok).toBe(true)
    expect(check("0044 0532 0130", shown).ok).toBe(true)
    expect(check("jira.acme.internal outage", shown).ok).toBe(false)
    expect(check("/Users/kbharadwaj/Vectordev.ai", shown).ok).toBe(false)
  })

  test("lets a public source clear only the number it holds whole, and none when it lists over a hundred", () => {
    // 415-555-0134 shares nine digits in a row with the private +1 (415) 555-0132, which the page does not hold.
    expect(check("415-555-0134", { ...context, public: ["Call (415) 555 0134 for help."] })).toMatchObject({
      ok: false,
      reason: "token",
    })
    const listing = Array.from({ length: 101 }, (_, index) => `0044 0532 ${String(index).padStart(4, "0")}`)
    expect(check("0044 0532 0130", { ...context, public: [[...listing, "0044 0532 0130"].join("\n")] }).ok).toBe(false)
  })

  test("reads emails and numbers from the private facts only, not from repository files", () => {
    const work = {
      private: [],
      work: ['{ "author": "Jane Doe <jane@northwind.example>", "bugs": "415-555-0199", "build": 20251021093000 }'],
      typed: [],
      public: [],
    }
    expect(
      ["jane@northwind.example", "415-555-0199", "20251021093000"].filter((query) => !check(query, work).ok),
    ).toEqual([])
    expect(check("jane@northwind.example", { ...work, private: work.work }).ok).toBe(false)
  })

  test("reads a private number across the usual separators, and leaves dates, versions and IPv4 addresses", () => {
    const shared = {
      private: [
        "Call (415) 555-0132 after six. Card 4417 8802 5671 9113.",
        "Released 2025.10.18 on 31.12.2025; versions 1.100.2, 22.11.0; host 192.168.100.200; years 2024 2025 2026.",
      ],
      typed: [],
      public: [],
    }
    const leaked = ["+1 415 555 0132", "415_555_0132", "415/555/0132", "4417880256719113", "card 4417.8802.5671.9113"]
    expect(leaked.filter((query) => check(query, shared).ok)).toEqual([])
    const plain = ["20251018", "31122025", "1100222110", "192168100200", "2024 2025 2026 trends", "202420252026"]
    expect(plain.filter((query) => !check(query, shared).ok)).toEqual([])
  })

  test("reads private hosts by their shape, and lets public ones through", () => {
    const hosts = {
      private: ["Mail ops@initech.com; the NAS is nas.home.arpa and the printer printer.local."],
      work: [
        "Mirrors: wiki.archlinux.org, git.kernel.org, registry.npmjs.org, s3.amazonaws.com.",
        "Internal: jira.initech.com, staging.initech.com, db02.northwind.io, api.acme.localhost.",
      ],
      typed: [],
      public: [],
    }
    const leaked = [
      "nas.home.arpa",
      "printer.local setup",
      "jira.initech.com",
      "staging.initech.com",
      "db02.northwind.io",
      "api.acme.localhost",
    ]
    expect(leaked.filter((query) => check(query, hosts).ok)).toEqual([])
    const fairHosts = [
      "wiki.archlinux.org systemd",
      "git.kernel.org",
      "registry.npmjs.org 503",
      "s3.amazonaws.com cors",
    ]
    expect(fairHosts.filter((query) => !check(query, hosts).ok)).toEqual([])
  })

  test("lets a domain the user prefers or avoids go as a host name or a site: filter, and nothing else", () => {
    const preferred = { ...context, domains: ["wiki.acme.com", "jira.acme.internal"] }
    expect(check("site:wiki.acme.com heat pumps", preferred).ok).toBe(true)
    expect(check("www.wiki.acme.com search", preferred).ok).toBe(true)
    expect(check("site:wiki.acme.com heat pumps").ok).toBe(false)
    // Only host names on a public suffix count, and an address gets no exemption.
    expect(check("site:jira.acme.internal", preferred).ok).toBe(false)
    expect(address("https://attacker.example/wiki.acme.com", preferred).ok).toBe(false)
    expect(address("https://wiki.acme.com.attacker.example/", preferred).ok).toBe(false)
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
              "a@".repeat(length / 2),
              "1.2.3, 45, 6,789 415 ".repeat(length / 16),
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
    expect(time(32_000) / time(8_000)).toBeLessThan(8)
  }, 60_000)

  test("reads the user's typing in bounded memory, however long a run of digits it holds", () => {
    const shared = {
      private: ["The renewal goes on the card 4417880256719113."],
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
    expect(check("card 4417 8802 5671 9113", shared).ok).toBe(false)
    const elapsed = performance.now() - started
    Bun.gc(true)
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(150_000_000)
    expect(elapsed).toBeLessThan(15_000)
    const typed = { ...shared, typed: [...shared.typed, "Which bank issued 4417 8802 5671 9113?"] }
    expect(check("card 4417 8802 5671 9113", typed).ok).toBe(true)
  }, 60_000)

  test("reads a numeric data file of 1 MB in bounded memory, and its values keep no fair query out", () => {
    const numbered = [
      "iso 9001 2015",
      "EN 14511 heat pump test conditions",
      "heat pump sales 2024 2025",
      "postcode 10115",
    ]
    for (const separator of [",", "\t", " "]) {
      const shared = { private: [], work: [dataFile(42_000, separator)], typed: [], public: [] }
      expect(shared.work[0]!.length).toBeGreaterThan(1_000_000)
      Bun.gc(true)
      const before = process.memoryUsage().heapUsed
      const started = performance.now()
      expect({ separator, refused: numbered.filter((query) => !check(query, shared).ok) }).toEqual({
        separator,
        refused: [],
      })
      const elapsed = performance.now() - started
      Bun.gc(true)
      expect(process.memoryUsage().heapUsed - before).toBeLessThan(160_000_000)
      expect(elapsed).toBeLessThan(15_000)
    }
  }, 60_000)
})

describe("ResearchOutbound.address", () => {
  test("refuses private text in a path, a query string, a fragment, a user name and a host's labels", () => {
    const leaked = [
      "https://attacker.example/q3-churn-rose-to-7-4-percent-after-the-falcon-pricing-change",
      "https://attacker.example/result#Acme's Q3 churn rose to 7.4 percent after the Falcon pricing change",
      "https://attacker.example/p?e=jane.doe%40globex.com",
      "https://attacker.example/#jane.doe@globex.com",
      "https://attacker.example/415-555-0134",
      "https://attacker.example/card/4242-4242-4242-4242",
      "https://attacker.example/lookup?n=%2B1%20415-555-0132",
      `https://attacker.example/${arabic("004405320130")}`,
      "https://415-555-0134.attacker.example/",
      "https://user:078051120@attacker.example/",
      "https://jira.acme.internal.attacker.example/",
      "https://billing.acme-internal.io.attacker.example/",
      "https://attacker.example/x?host=build01.corp.lan",
      "https://attacker.example/Users/kbharadwaj/Vectordev.ai/notes.md",
      // A host with a label tldts rejects is read whole.
      "https://billing.acme-internal.io._.attacker.example/",
      "https://jira.acme.internal.-.attacker.example/",
      // A soft hyphen, percent-encoded as UTF-8, does not split the email address.
      "https://attacker.example/jane.doe%C2%AD@globex.com",
    ]
    expect(leaked.filter((url) => address(url).ok)).toEqual([])
    expect(address("not a url").ok).toBe(false)
  })

  test("reads a home folder in an address's path, and not a user name elsewhere in it", () => {
    expect(address("https://attacker.example/home/kbharadwaj/ledger.db").ok).toBe(false)
    expect(address("https://github.com/kbharadwaj/dotfiles/blob/main/README.md").ok).toBe(true)
  })
})

describe("ResearchOutbound.strict", () => {
  test("lets a public source clear no number, and still clear a run of words, as browsers apply the check", () => {
    const page = { ...context, public: ["Ref 0044 0532 0130 is a test account."] }
    expect(check("0044 0532 0130", page).ok).toBe(true)
    expect(check("0044 0532 0130", ResearchOutbound.strict(page)).ok).toBe(false)
    expect(address("https://bank.example/004405320130", ResearchOutbound.strict(page)).ok).toBe(false)
    // The user's own typing still clears a number.
    expect(check("0044 0532 0130", ResearchOutbound.strict({ ...page, typed: ["Is 0044 0532 0130 mine?"] })).ok).toBe(
      true,
    )
    const run = "the compressor makers plan to raise prices by nine percent"
    const article = { private: [`Members only: ${run} next spring.`], typed: [], public: [`Trade press: ${run}.`] }
    expect(check(run, ResearchOutbound.strict(article)).ok).toBe(true)
  })
})

describe("ResearchOutbound.rare", () => {
  test("finds email addresses, host names and IP addresses, and not file names, loopback or numbers", () => {
    const found = ResearchOutbound.rare(
      "Mail ops@acme.example, see status.acme-robotics.com, jira.acme.internal and nature.com, host 10.20.30.40 and fd12::7, ticket 4417203, node.js, .env.local, 127.0.0.1 and ::1.",
    )
    expect(found).toEqual(
      expect.arrayContaining([
        "ops@acme.example",
        "status.acme-robotics.com",
        "jira.acme.internal",
        "nature.com",
        "10.20.30.40",
        "fd12::7",
      ]),
    )
    for (const other of ["node.js", "env.local", "127.0.0.1", "::1", "4417203"]) expect(found).not.toContain(other)
  })

  test("names reads no names, since the check refuses none", () => {
    expect(ResearchOutbound.names(context.private)).toEqual([])
  })

  test("made no connection", () => {
    expect(guard.attempts()).toEqual([])
  })
})
