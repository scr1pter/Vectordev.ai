// The facts a team teaches its agent once, and sixteen tasks over six simulated weeks that need them again. Each fact
// is taught one way (the user says it, a check breaks, or a spec PDF says it) and needed later by tasks whose prompts
// do not repeat it. Prompts name the files to change, as a user who knows the code would, and nothing more.

import { BASE, REGISTRY, refundPolicyPdf } from "./fixture"

export type FactID = "pnpm" | "cents" | "routes" | "window" | "idempotency" | "email" | "events" | "clock"

export type Fact = {
  readonly id: FactID
  readonly kind: "user preference" | "decision and its reason" | "build gotcha" | "spec value" | "spec requirement" | "naming convention" | "flaky-test fix"
  readonly summary: string
  /**
   * What in a request shows the scripted model the fact: its words in the user's message, a memory line, a document
   * card, an error, a file it read. Tested against everything the request carries except the model's own tool calls.
   */
  readonly marker: RegExp
  /** What the model saves when it learns the fact in a session (none for document facts: the document is the memory). */
  readonly memory?: { readonly kind: "preference" | "decision" | "lesson" | "fact"; readonly text: string }
}

export const FACTS: readonly Fact[] = [
  {
    id: "pnpm",
    kind: "user preference",
    summary: "The repository uses pnpm; npm writes a package-lock.json the check rejects.",
    marker: /\bpnpm\b/,
    memory: {
      kind: "preference",
      text: "We use pnpm in this repository, never npm: add dependencies with pnpm add and run scripts with pnpm.",
    },
  },
  {
    id: "cents",
    kind: "decision and its reason",
    summary: "Money amounts are integer cents, because float rounding put invoice totals a cent off.",
    marker: /integer cents/i,
    memory: {
      kind: "decision",
      text: "Money amounts (orders, invoices, refunds and fees) are integer cents, never decimal dollars, because float rounding put invoice totals a cent off.",
    },
  },
  {
    id: "routes",
    kind: "build gotcha",
    summary: "After changing src/routes.ts, run pnpm gen, or the check fails on a stale generated file.",
    marker: /\bpnpm gen\b/,
    memory: {
      kind: "lesson",
      text: "After changing src/routes.ts run pnpm gen: a stale src/generated/routes.gen.ts fails the check.",
    },
  },
  {
    id: "window",
    kind: "spec value",
    summary: "Refunds are allowed for at most 14 days after capture (refund policy PDF, section 2).",
    marker: /\b14 days\b/,
  },
  {
    id: "idempotency",
    kind: "spec requirement",
    summary: "POST /refunds rejects a request without an Idempotency-Key header with status 400 (refund policy PDF, section 3).",
    marker: /Idempotency-Key/,
  },
  {
    id: "email",
    kind: "spec value",
    summary: "The refund email's subject is 'Your refund for order <order id>' (refund policy PDF, section 4).",
    marker: /Your refund for order/,
  },
  {
    id: "events",
    kind: "naming convention",
    summary: "Event names are lowercase <domain>.<past-tense verb>, such as invoice.paid.",
    marker: /past-tense verb|emit\("[a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*"/,
    memory: {
      kind: "decision",
      text: "Our event names are lowercase <domain>.<past-tense verb>, such as invoice.paid, never upper snake case like INVOICE_PAID or camelCase, in the events we emit.",
    },
  },
  {
    id: "clock",
    kind: "flaky-test fix",
    summary: "Tests that depend on time use createClock from src/clock.ts: real time made a test flaky on CI.",
    marker: /createClock/,
    memory: {
      kind: "lesson",
      text: "Tests that depend on time must use createClock from src/clock.ts, not Date.now or sleeps: real time made test/session.test.ts flaky on CI (pnpm test:ci).",
    },
  },
]

export function fact(id: FactID) {
  return FACTS.find((item) => item.id === id)!
}

export type Files = Readonly<Record<string, string>>

/** One change the model makes: a replacement in a file it read, or a whole new file. */
export type Change =
  | { readonly path: string; readonly from: string; readonly to: string }
  | { readonly path: string; readonly content: string }

export type Task = {
  readonly id: string
  readonly week: number
  readonly day: string
  readonly title: string
  readonly prompt: string
  /** Files that appear in the repository before this task starts (the spec PDF). */
  readonly arrives?: Readonly<Record<string, Uint8Array>>
  /** Files the owner keeps as documents in Vector's memory before this task (brain on only; nothing to keep it in otherwise). */
  readonly upload?: readonly string[]
  /** What the model reads first: the files it is about to change or build on. */
  readonly reads: readonly string[]
  /** Commands the model runs to investigate before it changes anything. */
  readonly investigate?: readonly { readonly command?: string; readonly read?: string }[]
  /** Checks the user asked for, run after the tests and the check. */
  readonly verify?: readonly string[]
  /** A package to add before the code that uses it. */
  readonly dependency?: string
  /** The changes, given what the model knows when it makes them. With every fact known, these are the reference solution. */
  readonly changes: (state: Files, knows: (id: FactID) => boolean) => readonly Change[]
  /** Facts the task needs; a mistake on one is counted when the work gets it wrong. */
  readonly needs: readonly FactID[]
  /** Facts the task teaches, and the evidence the model saves with what it learned. */
  readonly teaches: readonly { readonly fact: FactID; readonly quote?: string }[]
  /** Hidden acceptance tests the harness runs after the agent finishes, as `test(name)` bodies; `fact:<id>` names one fact. */
  readonly acceptance: string
}

const DAY_MS = "86_400_000"

export const TASKS: readonly Task[] = [
  {
    id: "t01-slugify",
    week: 1,
    day: "Mon",
    title: "A slug helper on a new dependency; the user says once that the repository uses pnpm",
    prompt:
      "Add a `slugify(title)` helper in src/util/slug.ts, built on the `tiny-slug` package (add it as a dependency), with a test. We use pnpm in this repository, never npm: add dependencies with pnpm add and run scripts with pnpm.",
    reads: [],
    dependency: "tiny-slug",
    changes: () => [
      {
        path: "src/util/slug.ts",
        content: [
          'import slug from "tiny-slug"',
          "",
          "/** A URL-safe form of a title: lowercase words joined by hyphens. */",
          "export function slugify(title: string) {",
          "  return slug(title)",
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "test/slug.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { slugify } from "../src/util/slug"',
          "",
          'test("slugify joins lowercase words with hyphens", () => {',
          '  expect(slugify("Spring Sale: 20% off!")).toBe("spring-sale-20-off")',
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["pnpm"],
    teaches: [{ fact: "pnpm", quote: "We use pnpm in this repository, never npm: add dependencies with pnpm add and run scripts with pnpm." }],
    acceptance: [
      'test("slugify", async () => {',
      '  const { slugify } = await import("../src/util/slug")',
      '  expect(slugify("Hello World")).toBe("hello-world")',
      "})",
      pnpmFact("tiny-slug"),
    ].join("\n"),
  },
  {
    id: "t02-late-fee-cents",
    week: 1,
    day: "Tue",
    title: "The team decides money is integer cents, and says why",
    prompt:
      "Money amounts (orders, invoices, refunds and fees) are integer cents from now on, never decimal dollars, because float rounding put last month's invoice totals a cent off. Change `lateFee` in src/invoice.ts to return 2% of the amount in integer cents, rounded, and update its test.",
    reads: ["src/invoice.ts", "test/invoice.test.ts"],
    changes: () => [
      { path: "src/invoice.ts", from: "  return invoice.amount * 0.02", to: "  return Math.round((invoice.amount * 2) / 100)" },
      {
        path: "test/invoice.test.ts",
        from: '  expect(lateFee({ id: "a", amount: 100, dueOn: "2026-03-01" })).toBe(2)',
        to: '  expect(lateFee({ id: "a", amount: 12_345, dueOn: "2026-03-01" })).toBe(247)',
      },
    ],
    needs: [],
    teaches: [
      {
        fact: "cents",
        quote:
          "Money amounts (orders, invoices, refunds and fees) are integer cents from now on, never decimal dollars, because float rounding put last month's invoice totals a cent off.",
      },
    ],
    acceptance: [
      'test("fact:cents", async () => {',
      '  const { lateFee } = await import("../src/invoice")',
      '  expect(lateFee({ id: "a", amount: 12_345, dueOn: "2026-03-01" })).toBe(247)',
      '  for (const amount of [1, 99, 1_999, 12_345]) expect(Number.isInteger(lateFee({ id: "a", amount, dueOn: "2026-03-01" }))).toBe(true)',
      "})",
    ].join("\n"),
  },
  {
    id: "t03-invoice-pdf-route",
    week: 1,
    day: "Thu",
    title: "A new route; the check breaks on the stale generated route table",
    prompt:
      "Add a GET /invoices/:id/pdf route handled by `renderInvoicePdf` in src/invoice-pdf.ts, which returns the invoice as plain text for now.",
    reads: ["src/routes.ts", "src/invoice.ts"],
    changes: () => [
      route('  { method: "GET", path: "/invoices/:id/pdf", handler: "renderInvoicePdf" },'),
      {
        path: "src/invoice-pdf.ts",
        content: [
          'import type { Invoice } from "./invoice"',
          "",
          "/** The invoice as a printable document; plain text until the PDF renderer lands. */",
          "export function renderInvoicePdf(invoice: Invoice) {",
          "  return [`Invoice ${invoice.id}`, `Amount: ${invoice.amount}`, `Due: ${invoice.dueOn}`].join(\"\\n\")",
          "}",
          "",
        ].join("\n"),
      },
    ],
    needs: ["routes"],
    teaches: [{ fact: "routes" }],
    acceptance: [
      'test("renderInvoicePdf", async () => {',
      '  const { renderInvoicePdf } = await import("../src/invoice-pdf")',
      '  expect(renderInvoicePdf({ id: "i1", amount: 100, dueOn: "2026-03-01" })).toContain("i1")',
      "})",
      routesFact("/invoices/:id/pdf"),
    ].join("\n"),
  },
  {
    id: "t04-refund-request",
    week: 2,
    day: "Mon",
    title: "Refund requests from the refund policy PDF, which the owner also keeps in Vector's memory",
    prompt: "Implement `requestRefund` in src/refunds.ts as our refund policy (docs/specs/refund-policy.pdf) describes, with tests.",
    arrives: { "docs/specs/refund-policy.pdf": refundPolicyPdf() },
    upload: ["docs/specs/refund-policy.pdf"],
    reads: ["docs/specs/refund-policy.pdf", "src/orders.ts"],
    changes: (_, knows) => [
      {
        path: "src/refunds.ts",
        content: knows("window")
          ? [
              'import type { Order } from "./orders"',
              "",
              "/** Refunds are allowed for at most this many days after capture (refund policy, section 2). */",
              "export const REFUND_WINDOW_DAYS = 14",
              "const DAY = 24 * 60 * 60 * 1000",
              "",
              "export type Refund = { id: string; orderId: string; amount: number; key: string; requestedOn: string }",
              'export type RefundResult = { ok: true; refund: Refund } | { ok: false; reason: "window_closed" | "too_much" }',
              "",
              "const byKey = new Map<string, Refund>()",
              "",
              "/** Requests a refund of part or all of an order; a repeated key returns the first refund (section 3). */",
              "export function requestRefund(order: Order, amount: number, key: string, now: Date): RefundResult {",
              "  const first = byKey.get(key)",
              "  if (first) return { ok: true, refund: first }",
              "  if (now.getTime() - new Date(order.capturedOn).getTime() > REFUND_WINDOW_DAYS * DAY)",
              '    return { ok: false, reason: "window_closed" }',
              '  if (amount > order.amount) return { ok: false, reason: "too_much" }',
              "  const refund = { id: `rf_${byKey.size + 1}`, orderId: order.id, amount, key, requestedOn: now.toISOString() }",
              "  byKey.set(key, refund)",
              "  return { ok: true, refund }",
              "}",
              "",
            ].join("\n")
          : [
              'import type { Order } from "./orders"',
              "",
              "export type Refund = { id: string; orderId: string; amount: number; key: string; requestedOn: string }",
              'export type RefundResult = { ok: true; refund: Refund } | { ok: false; reason: "too_much" }',
              "",
              "let count = 0",
              "",
              "export function requestRefund(order: Order, amount: number, key: string, now: Date): RefundResult {",
              '  if (amount > order.amount) return { ok: false, reason: "too_much" }',
              "  return { ok: true, refund: { id: `rf_${++count}`, orderId: order.id, amount, key, requestedOn: now.toISOString() } }",
              "}",
              "",
            ].join("\n"),
      },
      {
        path: "test/refunds.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { requestRefund } from "../src/refunds"',
          "",
          'const order = { id: "o1", customer: "c1", amount: 5_000, capturedOn: "2026-10-01T00:00:00.000Z" }',
          "",
          'test("a refund inside the window is accepted", () => {',
          '  expect(requestRefund(order, 1_000, "k1", new Date("2026-10-10T00:00:00.000Z")).ok).toBe(true)',
          "})",
          "",
          ...(knows("window")
            ? [
                'test("a refund after the window is rejected", () => {',
                '  expect(requestRefund(order, 1_000, "k2", new Date("2026-10-16T00:00:00.000Z"))).toEqual({ ok: false, reason: "window_closed" })',
                "})",
                "",
                'test("a repeated key returns the first refund", () => {',
                '  const first = requestRefund(order, 500, "k3", new Date("2026-10-02T00:00:00.000Z"))',
                '  expect(requestRefund(order, 500, "k3", new Date("2026-10-03T00:00:00.000Z"))).toEqual(first)',
                "})",
                "",
              ]
            : []),
        ].join("\n"),
      },
    ],
    needs: ["window"],
    // The PDF teaches these when it is read; it is its own memory, so nothing is saved from it.
    teaches: [{ fact: "window" }, { fact: "idempotency" }, { fact: "email" }],
    acceptance: [
      'const order = { id: "o9", customer: "c9", amount: 5_000, capturedOn: "2026-10-01T00:00:00.000Z" }',
      'test("fact:window", async () => {',
      '  const { requestRefund } = await import("../src/refunds")',
      '  expect(requestRefund(order, 100, "a1", new Date("2026-10-14T23:00:00.000Z")).ok).toBe(true)',
      '  expect(requestRefund(order, 100, "a2", new Date("2026-10-15T01:00:00.000Z"))).toEqual({ ok: false, reason: "window_closed" })',
      "})",
      'test("a repeated key returns the first refund", async () => {',
      '  const { requestRefund } = await import("../src/refunds")',
      '  const first = requestRefund(order, 100, "a3", new Date("2026-10-02T00:00:00.000Z"))',
      '  expect(requestRefund(order, 100, "a3", new Date("2026-10-02T01:00:00.000Z"))).toEqual(first)',
      "})",
    ].join("\n"),
  },
  {
    id: "t05-event-names",
    week: 2,
    day: "Tue",
    title: "The user states the event naming convention",
    prompt:
      "Our event names are lowercase `<domain>.<past-tense verb>`, such as `invoice.paid`, never upper snake case like INVOICE_PAID or camelCase. Rename the events src/invoice.ts emits to match.",
    reads: ["src/invoice.ts", "test/invoice.test.ts"],
    changes: () => [
      { path: "src/invoice.ts", from: '  emit("INVOICE_PAID", { id: invoice.id })', to: '  emit("invoice.paid", { id: invoice.id })' },
      {
        path: "test/invoice.test.ts",
        from: '  expect(emitted.at(-1)?.name).toBe("INVOICE_PAID")',
        to: '  expect(emitted.at(-1)?.name).toBe("invoice.paid")',
      },
    ],
    needs: [],
    teaches: [
      {
        fact: "events",
        quote:
          "Our event names are lowercase `<domain>.<past-tense verb>`, such as `invoice.paid`, never upper snake case like INVOICE_PAID or camelCase. Rename the events src/invoice.ts emits to match.",
      },
    ],
    acceptance: eventsFact(["src/invoice.ts"]),
  },
  {
    id: "t06-flaky-session-test",
    week: 2,
    day: "Thu",
    title: "A test that fails one CI run in five; the fix is an injected clock",
    prompt:
      "test/session.test.ts fails on CI about one run in five, though it passes on my machine. CI runs `pnpm test:ci`. Find out why and fix it.",
    reads: ["test/session.test.ts", "src/session.ts", "src/clock.ts"],
    investigate: [{ command: "pnpm test:ci" }, { read: "package.json" }, { read: "ci/slow-clock.ts" }],
    verify: ["pnpm test:ci"],
    changes: () => [
      {
        path: "test/session.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { createClock } from "../src/clock"',
          'import { isExpired, issueToken } from "../src/session"',
          "",
          "// Time comes from a clock the test moves: real time made these flaky on loaded CI runners.",
          'test("a fresh token is not expired", () => {',
          "  const clock = createClock()",
          "  const token = issueToken({ ttlMs: 200, clock })",
          "  expect(isExpired(token, clock)).toBe(false)",
          "})",
          "",
          'test("a token expires after its ttl", () => {',
          "  const clock = createClock()",
          "  const token = issueToken({ ttlMs: 20, clock })",
          "  clock.advance(30)",
          "  expect(isExpired(token, clock)).toBe(true)",
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["clock"],
    teaches: [{ fact: "clock" }],
    acceptance: 'test("fact:clock", () => {\n  expect(ciSuite()).toBe(0)\n})',
  },
  {
    id: "t07-order-discount",
    week: 3,
    day: "Mon",
    title: "A discount on orders: money arithmetic",
    prompt: "Add `discountedAmount(order, percent)` to src/orders.ts for the spring promotion, with tests.",
    reads: ["src/orders.ts", "test/orders.test.ts"],
    changes: (state, knows) => [
      {
        path: "src/orders.ts",
        content:
          state["src/orders.ts"] +
          (knows("cents")
            ? [
                "",
                "/** The order's amount after a percentage discount, in integer cents. */",
                "export function discountedAmount(order: Order, percent: number) {",
                "  return Math.round((order.amount * (100 - percent)) / 100)",
                "}",
                "",
              ]
            : [
                "",
                "/** The order's amount after a percentage discount. */",
                "export function discountedAmount(order: Order, percent: number) {",
                "  return order.amount * (1 - percent / 100)",
                "}",
                "",
              ]
          ).join("\n"),
      },
      {
        path: "test/orders.test.ts",
        content:
          state["test/orders.test.ts"]!.replace('import { orderTotal } from "../src/orders"', 'import { discountedAmount, orderTotal } from "../src/orders"') +
          [
            "",
            'test("a discount takes its percentage off the amount", () => {',
            `  expect(discountedAmount({ id: "o", customer: "c", amount: 1_999, capturedOn: "2026-10-01" }, 10)).${knows("cents") ? "toBe(1_799)" : "toBeCloseTo(1_799.1)"}`,
            "})",
            "",
          ].join("\n"),
      },
    ],
    needs: ["cents"],
    teaches: [],
    acceptance: [
      'test("fact:cents", async () => {',
      '  const { discountedAmount } = await import("../src/orders")',
      '  const order = (amount: number) => ({ id: "o", customer: "c", amount, capturedOn: "2026-10-01" })',
      "  expect(discountedAmount(order(1_999), 10)).toBe(1_799)",
      "  for (const amount of [1, 333, 1_999, 10_001]) expect(Number.isInteger(discountedAmount(order(amount), 15))).toBe(true)",
      "})",
    ].join("\n"),
  },
  {
    id: "t08-csv-export",
    week: 3,
    day: "Tue",
    title: "A CSV export on a new dependency",
    prompt: "Add `invoicesToCsv(invoices)` in src/export/csv.ts using the `tiny-csv` package (add it as a dependency), with a test.",
    reads: [],
    dependency: "tiny-csv",
    changes: () => [
      {
        path: "src/export/csv.ts",
        content: [
          'import { stringify } from "tiny-csv"',
          'import type { Invoice } from "../invoice"',
          "",
          "/** Invoices as CSV for the accountants: a header row, then one row per invoice. */",
          "export function invoicesToCsv(invoices: Invoice[]) {",
          "  return stringify([",
          '    ["id", "amount", "due_on", "paid_on"],',
          '    ...invoices.map((invoice) => [invoice.id, invoice.amount, invoice.dueOn, invoice.paidOn ?? ""]),',
          "  ])",
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "test/csv.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { invoicesToCsv } from "../src/export/csv"',
          "",
          'test("invoices become CSV rows under a header", () => {',
          '  expect(invoicesToCsv([{ id: "i1", amount: 1_250, dueOn: "2026-03-01" }])).toBe("id,amount,due_on,paid_on\\ni1,1250,2026-03-01,\\n")',
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["pnpm"],
    teaches: [],
    acceptance: [
      'test("invoicesToCsv", async () => {',
      '  const { invoicesToCsv } = await import("../src/export/csv")',
      '  expect(invoicesToCsv([{ id: "i2", amount: 5, dueOn: "2026-01-01", paidOn: "2026-01-02" }])).toContain("i2,5,2026-01-01,2026-01-02")',
      "})",
      pnpmFact("tiny-csv"),
    ].join("\n"),
  },
  {
    id: "t09-refunds-http",
    week: 3,
    day: "Thu",
    title: "Refunds over HTTP: a route, and a header the spec requires",
    prompt:
      "Expose refunds over HTTP: add a POST /refunds route handled by `postRefund` in src/http/refunds.ts, which calls requestRefund and answers with a status and a JSON body.",
    reads: ["src/routes.ts", "src/refunds.ts"],
    changes: (_, knows) => [
      route('  { method: "POST", path: "/refunds", handler: "postRefund" },'),
      {
        path: "src/http/refunds.ts",
        content: knows("idempotency")
          ? [
              'import type { Order } from "../orders"',
              'import { requestRefund } from "../refunds"',
              "",
              "export type HttpRequest = { headers: Record<string, string | undefined>; body: { order: Order; amount: number } }",
              "",
              "/** POST /refunds. A request without an Idempotency-Key header is rejected (refund policy, section 3). */",
              "export function postRefund(request: HttpRequest, now = new Date()) {",
              '  const key = request.headers["idempotency-key"]',
              '  if (!key) return { status: 400, body: { error: "Idempotency-Key header required" } }',
              "  const result = requestRefund(request.body.order, request.body.amount, key, now)",
              "  return result.ok ? { status: 201, body: result.refund } : { status: 422, body: { error: result.reason } }",
              "}",
              "",
            ].join("\n")
          : [
              'import type { Order } from "../orders"',
              'import { requestRefund } from "../refunds"',
              "",
              "export type HttpRequest = { headers: Record<string, string | undefined>; body: { order: Order; amount: number; key?: string } }",
              "",
              "/** POST /refunds. */",
              "export function postRefund(request: HttpRequest, now = new Date()) {",
              "  const result = requestRefund(request.body.order, request.body.amount, request.body.key ?? crypto.randomUUID(), now)",
              "  return result.ok ? { status: 201, body: result.refund } : { status: 422, body: { error: result.reason } }",
              "}",
              "",
            ].join("\n"),
      },
      {
        path: "test/http-refunds.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { postRefund } from "../src/http/refunds"',
          "",
          'const order = { id: "o1", customer: "c1", amount: 5_000, capturedOn: "2026-10-01T00:00:00.000Z" }',
          "",
          'test("a refund request is answered with 201", () => {',
          `  const answer = postRefund({ headers: ${knows("idempotency") ? '{ "idempotency-key": "h1" }' : "{}"}, body: { order, amount: 1_000 } }, new Date("2026-10-05T00:00:00.000Z"))`,
          "  expect(answer.status).toBe(201)",
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["routes", "idempotency"],
    teaches: [],
    acceptance: [
      'const order = { id: "o8", customer: "c8", amount: 5_000, capturedOn: "2026-10-01T00:00:00.000Z" }',
      'test("fact:idempotency", async () => {',
      '  const { postRefund } = await import("../src/http/refunds")',
      '  const now = new Date("2026-10-05T00:00:00.000Z")',
      "  expect(postRefund({ headers: {}, body: { order, amount: 100 } }, now).status).toBe(400)",
      '  expect(postRefund({ headers: { "idempotency-key": "z1" }, body: { order, amount: 100 } }, now).status).toBe(201)',
      "})",
      routesFact("/refunds"),
    ].join("\n"),
  },
  {
    id: "t10-refund-email",
    week: 4,
    day: "Mon",
    title: "The refund email: a subject the spec fixes, and a new event",
    prompt:
      "Email the customer when a refund goes through: add `refundEmail(refund, order)` in src/notify/refund-email.ts, which returns the subject and body and emits an event once the email is queued, with tests.",
    reads: ["src/refunds.ts", "src/events.ts"],
    changes: (_, knows) => [
      {
        path: "src/notify/refund-email.ts",
        content: [
          'import { emit } from "../events"',
          'import type { Order } from "../orders"',
          'import type { Refund } from "../refunds"',
          "",
          "/** The email a customer gets for a refund; queuing it is recorded as an event. */",
          "export function refundEmail(refund: Refund, order: Order) {",
          "  const email = {",
          `    subject: \`${knows("email") ? "Your refund for order ${order.id}" : "Refund issued for order ${order.id}"}\`,`,
          "    body: `We have refunded ${refund.amount} cents of order ${order.id}.`,",
          "  }",
          `  emit("${knows("events") ? "refund.emailed" : "REFUND_EMAIL_QUEUED"}", { refund: refund.id, customer: order.customer })`,
          "  return email",
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "test/refund-email.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { emitted } from "../src/events"',
          'import { refundEmail } from "../src/notify/refund-email"',
          "",
          'const order = { id: "o7", customer: "c7", amount: 5_000, capturedOn: "2026-10-01T00:00:00.000Z" }',
          'const refund = { id: "rf_1", orderId: "o7", amount: 1_000, key: "k", requestedOn: "2026-10-02T00:00:00.000Z" }',
          "",
          'test("the refund email names the order and is queued as an event", () => {',
          `  expect(refundEmail(refund, order).subject).toBe("${knows("email") ? "Your refund for order o7" : "Refund issued for order o7"}")`,
          `  expect(emitted.at(-1)?.name).toBe("${knows("events") ? "refund.emailed" : "REFUND_EMAIL_QUEUED"}")`,
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["email", "events"],
    teaches: [],
    acceptance: [
      'test("fact:email", async () => {',
      '  const { refundEmail } = await import("../src/notify/refund-email")',
      '  const order = { id: "o6", customer: "c6", amount: 5_000, capturedOn: "2026-10-01T00:00:00.000Z" }',
      '  const refund = { id: "rf_9", orderId: "o6", amount: 1_000, key: "k", requestedOn: "2026-10-02T00:00:00.000Z" }',
      '  expect(refundEmail(refund, order).subject).toBe("Your refund for order o6")',
      "})",
      eventsFact(["src/notify/refund-email.ts"]),
    ].join("\n"),
  },
  {
    id: "t11-reset-link-expiry",
    week: 4,
    day: "Tue",
    title: "Password reset links that expire: tests that depend on time",
    prompt: "Password reset links should expire after 30 minutes. Add them in src/auth/reset.ts, with tests.",
    reads: [],
    changes: (_, knows) =>
      knows("clock")
        ? [
            {
              path: "src/auth/reset.ts",
              content: [
                'import { systemClock, type Clock } from "../clock"',
                "",
                "export const RESET_TTL_MS = 30 * 60 * 1000",
                "",
                "export type ResetLink = { token: string; userId: string; expiresAt: number }",
                "",
                "export function createResetLink(userId: string, clock: Clock = systemClock): ResetLink {",
                "  return { token: crypto.randomUUID(), userId, expiresAt: clock.now() + RESET_TTL_MS }",
                "}",
                "",
                "export function isResetLinkExpired(link: ResetLink, clock: Clock = systemClock) {",
                "  return clock.now() >= link.expiresAt",
                "}",
                "",
              ].join("\n"),
            },
            {
              path: "test/reset.test.ts",
              content: [
                'import { expect, test } from "bun:test"',
                'import { createResetLink, isResetLinkExpired } from "../src/auth/reset"',
                'import { createClock } from "../src/clock"',
                "",
                "const MINUTE = 60_000",
                "",
                'test("a reset link works for 30 minutes", () => {',
                "  const clock = createClock()",
                '  const link = createResetLink("u1", clock)',
                "  clock.advance(29 * MINUTE)",
                "  expect(isResetLinkExpired(link, clock)).toBe(false)",
                "  clock.advance(2 * MINUTE)",
                "  expect(isResetLinkExpired(link, clock)).toBe(true)",
                "})",
                "",
              ].join("\n"),
            },
          ]
        : [
            {
              path: "src/auth/reset.ts",
              content: [
                "export const RESET_TTL_MS = 30 * 60 * 1000",
                "",
                "export type ResetLink = { token: string; userId: string; expiresAt: number }",
                "",
                "export function createResetLink(userId: string, ttlMs = RESET_TTL_MS): ResetLink {",
                "  return { token: crypto.randomUUID(), userId, expiresAt: Date.now() + ttlMs }",
                "}",
                "",
                "export function isResetLinkExpired(link: ResetLink) {",
                "  return Date.now() >= link.expiresAt",
                "}",
                "",
              ].join("\n"),
            },
            {
              path: "test/reset.test.ts",
              content: [
                'import { expect, test } from "bun:test"',
                'import { createResetLink, isResetLinkExpired } from "../src/auth/reset"',
                "",
                'test("a new reset link is valid", () => {',
                '  expect(isResetLinkExpired(createResetLink("u1", 200))).toBe(false)',
                "})",
                "",
                'test("a reset link expires after its ttl", async () => {',
                '  const link = createResetLink("u1", 20)',
                "  await Bun.sleep(30)",
                "  expect(isResetLinkExpired(link)).toBe(true)",
                "})",
                "",
              ].join("\n"),
            },
          ],
    needs: ["clock"],
    teaches: [],
    acceptance: [
      'test("reset links last 30 minutes", async () => {',
      '  const { createResetLink, isResetLinkExpired } = await import("../src/auth/reset")',
      '  const start = Date.parse("2026-10-20T09:00:00.000Z")',
      "  setSystemTime(start)",
      '  const link = createResetLink("u9")',
      "  setSystemTime(start + 29 * 60_000)",
      "  expect(isResetLinkExpired(link)).toBe(false)",
      "  setSystemTime(start + 31 * 60_000)",
      "  expect(isResetLinkExpired(link)).toBe(true)",
      "  setSystemTime()",
      "})",
      'test("fact:clock", () => {\n  expect(ciSuite()).toBe(0)\n})',
    ].join("\n"),
  },
  {
    id: "t12-shipping-fee",
    week: 4,
    day: "Thu",
    title: "A shipping fee: money arithmetic again",
    prompt: "Add `shippingFee(order)` to src/orders.ts: 4.5% of the order amount, but at least the minimum fee of 300, with tests.",
    reads: ["src/orders.ts", "test/orders.test.ts"],
    changes: (state, knows) => [
      {
        path: "src/orders.ts",
        content:
          state["src/orders.ts"] +
          (knows("cents")
            ? [
                "",
                "/** Shipping: 4.5% of the amount, at least 300, in integer cents. */",
                "export function shippingFee(order: Order) {",
                "  return Math.max(300, Math.round((order.amount * 45) / 1000))",
                "}",
                "",
              ]
            : ["", "/** Shipping: 4.5% of the amount, at least 300. */", "export function shippingFee(order: Order) {", "  return Math.max(300, order.amount * 0.045)", "}", ""]
          ).join("\n"),
      },
      {
        path: "test/orders.test.ts",
        content:
          state["test/orders.test.ts"]!.replace(/import \{ (.*)orderTotal \} from "\.\.\/src\/orders"/, 'import { $1orderTotal, shippingFee } from "../src/orders"') +
          [
            "",
            'test("shipping is 4.5% of the amount, at least 300", () => {',
            `  expect(shippingFee({ id: "o", customer: "c", amount: 12_345, capturedOn: "2026-10-01" })).${knows("cents") ? "toBe(556)" : "toBeCloseTo(555.525)"}`,
            '  expect(shippingFee({ id: "o", customer: "c", amount: 1_000, capturedOn: "2026-10-01" })).toBe(300)',
            "})",
            "",
          ].join("\n"),
      },
    ],
    needs: ["cents"],
    teaches: [],
    acceptance: [
      'test("fact:cents", async () => {',
      '  const { shippingFee } = await import("../src/orders")',
      '  const order = (amount: number) => ({ id: "o", customer: "c", amount, capturedOn: "2026-10-01" })',
      "  expect(shippingFee(order(12_345))).toBe(556)",
      "  expect(shippingFee(order(1_000))).toBe(300)",
      "  for (const amount of [7_001, 9_999, 33_333]) expect(Number.isInteger(shippingFee(order(amount)))).toBe(true)",
      "})",
    ].join("\n"),
  },
  {
    id: "t13-credit-notes",
    week: 5,
    day: "Mon",
    title: "Credit notes: a new route and a new event in a new module",
    prompt:
      "Add credit notes: `voidCreditNote(note)` in src/credit-notes.ts, which marks a note void and emits an event, and a POST /credit-notes/:id/void route handled by it.",
    reads: ["src/routes.ts", "src/events.ts"],
    changes: (_, knows) => [
      route('  { method: "POST", path: "/credit-notes/:id/void", handler: "voidCreditNote" },'),
      {
        path: "src/credit-notes.ts",
        content: [
          'import { emit } from "./events"',
          "",
          'export type CreditNote = { id: string; invoiceId: string; amount: number; status: "open" | "void" }',
          "",
          "export function voidCreditNote(note: CreditNote): CreditNote {",
          `  emit("${knows("events") ? "credit_note.voided" : "CREDIT_NOTE_VOIDED"}", { id: note.id, invoice: note.invoiceId })`,
          '  return { ...note, status: "void" }',
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "test/credit-notes.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { voidCreditNote } from "../src/credit-notes"',
          "",
          'test("voiding a credit note marks it void", () => {',
          '  expect(voidCreditNote({ id: "cn1", invoiceId: "i1", amount: 500, status: "open" }).status).toBe("void")',
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["routes", "events"],
    teaches: [],
    acceptance: [eventsFact(["src/credit-notes.ts"]), routesFact("/credit-notes/:id/void")].join("\n"),
  },
  {
    id: "t14-pdf-dependency",
    week: 5,
    day: "Thu",
    title: "Real invoice PDFs on a new dependency",
    prompt:
      "Render invoice PDFs for real: make `renderInvoicePdf` in src/invoice-pdf.ts use the `tiny-pdf` package (add it as a dependency), with a test.",
    reads: ["src/invoice-pdf.ts"],
    dependency: "tiny-pdf",
    changes: (state) => [
      {
        path: "src/invoice-pdf.ts",
        content: state["src/invoice-pdf.ts"]!
          .replace('import type { Invoice } from "./invoice"', 'import { render } from "tiny-pdf"\nimport type { Invoice } from "./invoice"')
          .replace("/** The invoice as a printable document; plain text until the PDF renderer lands. */", "/** The invoice as a PDF. */")
          .replace(
            "  return [`Invoice ${invoice.id}`, `Amount: ${invoice.amount}`, `Due: ${invoice.dueOn}`].join(\"\\n\")",
            "  return render([`Invoice ${invoice.id}`, `Amount: ${invoice.amount}`, `Due: ${invoice.dueOn}`])",
          ),
      },
      {
        path: "test/invoice-pdf.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { renderInvoicePdf } from "../src/invoice-pdf"',
          "",
          'test("an invoice renders as a PDF", () => {',
          '  expect(renderInvoicePdf({ id: "i1", amount: 100, dueOn: "2026-03-01" })).toStartWith("%PDF-")',
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["pnpm"],
    teaches: [],
    acceptance: [
      'test("renderInvoicePdf", async () => {',
      '  const { renderInvoicePdf } = await import("../src/invoice-pdf")',
      '  expect(renderInvoicePdf({ id: "i3", amount: 100, dueOn: "2026-03-01" })).toContain("(Invoice i3) Tj")',
      "})",
      pnpmFact("tiny-pdf"),
    ].join("\n"),
  },
  {
    id: "t15-refund-deadline",
    week: 6,
    day: "Mon",
    title: "The refund deadline on the invoice: a value only the spec gives",
    prompt: "Print the last day a customer can ask for a refund on each invoice: add `refundDeadline(order)` to src/invoice-pdf.ts, with tests.",
    reads: ["src/invoice-pdf.ts", "src/orders.ts"],
    changes: (state, knows) => [
      {
        path: "src/invoice-pdf.ts",
        content: [
          state["src/invoice-pdf.ts"]!.replace('import type { Invoice } from "./invoice"', 'import type { Invoice } from "./invoice"\nimport type { Order } from "./orders"'),
          `/** The last day a refund can be asked for: ${knows("window") ? "14" : "30"} days after capture. */`,
          "export function refundDeadline(order: Order) {",
          `  return new Date(new Date(order.capturedOn).getTime() + ${knows("window") ? 14 : 30} * ${DAY_MS}).toISOString().slice(0, 10)`,
          "}",
          "",
        ].join("\n"),
      },
      {
        path: "test/refund-deadline.test.ts",
        content: [
          'import { expect, test } from "bun:test"',
          'import { refundDeadline } from "../src/invoice-pdf"',
          "",
          'test("the refund deadline follows the capture date", () => {',
          `  expect(refundDeadline({ id: "o", customer: "c", amount: 100, capturedOn: "2026-10-01T00:00:00.000Z" })).toBe("${knows("window") ? "2026-10-15" : "2026-10-31"}")`,
          "})",
          "",
        ].join("\n"),
      },
    ],
    needs: ["window"],
    teaches: [],
    acceptance: [
      'test("fact:window", async () => {',
      '  const { refundDeadline } = await import("../src/invoice-pdf")',
      '  expect(refundDeadline({ id: "o", customer: "c", amount: 100, capturedOn: "2026-11-01T00:00:00.000Z" })).toBe("2026-11-15")',
      "})",
    ].join("\n"),
  },
  {
    id: "t16-late-fee-grace",
    week: 6,
    day: "Thu",
    title: "A grace period for late fees: a boundary test that depends on time",
    prompt: "Only charge the late fee once an invoice is more than 3 days overdue: add `lateFeeDue(invoice)` to src/invoice.ts, with tests.",
    reads: ["src/invoice.ts", "test/invoice.test.ts"],
    changes: (state, knows) => [
      {
        path: "src/invoice.ts",
        content: knows("clock")
          ? state["src/invoice.ts"]!.replace('import { emit } from "./events"', 'import { systemClock, type Clock } from "./clock"\nimport { emit } from "./events"') +
            [
              "",
              "const GRACE_MS = 3 * 86_400_000",
              "",
              "/** The late fee once an invoice is more than three days overdue, else nothing. */",
              "export function lateFeeDue(invoice: Invoice, clock: Clock = systemClock) {",
              "  return clock.now() - new Date(invoice.dueOn).getTime() > GRACE_MS ? lateFee(invoice) : 0",
              "}",
              "",
            ].join("\n")
          : state["src/invoice.ts"] +
            [
              "",
              "const GRACE_MS = 3 * 86_400_000",
              "",
              "/** The late fee once an invoice is more than three days overdue, else nothing. */",
              "export function lateFeeDue(invoice: Invoice) {",
              "  return Date.now() - new Date(invoice.dueOn).getTime() > GRACE_MS ? lateFee(invoice) : 0",
              "}",
              "",
            ].join("\n"),
      },
      {
        path: "test/late-fee.test.ts",
        content: knows("clock")
          ? [
              'import { expect, test } from "bun:test"',
              'import { createClock } from "../src/clock"',
              'import { lateFeeDue } from "../src/invoice"',
              "",
              `const DAY = ${DAY_MS}`,
              'const invoice = { id: "a", amount: 10_000, dueOn: "2026-03-01T00:00:00.000Z" }',
              "",
              'test("no fee until the invoice is more than three days overdue", () => {',
              "  const clock = createClock(Date.parse(invoice.dueOn) + 3 * DAY)",
              "  expect(lateFeeDue(invoice, clock)).toBe(0)",
              "  clock.advance(1)",
              "  expect(lateFeeDue(invoice, clock)).toBe(200)",
              "})",
              "",
            ].join("\n")
          : [
              'import { expect, test } from "bun:test"',
              'import { lateFeeDue } from "../src/invoice"',
              "",
              `const DAY = ${DAY_MS}`,
              "",
              'test("no fee while an invoice is not yet three days overdue", () => {',
              '  expect(lateFeeDue({ id: "a", amount: 10_000, dueOn: new Date(Date.now() - 3 * DAY + 100).toISOString() })).toBe(0)',
              "})",
              "",
              'test("the fee is due after three days", () => {',
              '  expect(lateFeeDue({ id: "b", amount: 10_000, dueOn: new Date(Date.now() - 4 * DAY).toISOString() })).toBe(200)',
              "})",
              "",
            ].join("\n"),
      },
    ],
    needs: ["clock"],
    teaches: [],
    acceptance: [
      'test("late fees wait out a three-day grace period", async () => {',
      '  const { lateFeeDue } = await import("../src/invoice")',
      '  const invoice = { id: "z", amount: 10_000, dueOn: "2026-03-01T00:00:00.000Z" }',
      '  setSystemTime(Date.parse("2026-03-03T23:00:00.000Z"))',
      "  expect(lateFeeDue(invoice)).toBe(0)",
      '  setSystemTime(Date.parse("2026-03-04T01:00:00.000Z"))',
      "  expect(lateFeeDue(invoice)).toBe(200)",
      "  setSystemTime()",
      "})",
      'test("fact:clock", () => {\n  expect(ciSuite()).toBe(0)\n})',
    ].join("\n"),
  },
]

/** The preamble every acceptance file starts with: what its tests share. */
export const ACCEPTANCE_PREAMBLE = [
  'import { expect, setSystemTime, test } from "bun:test"',
  'import { existsSync, readFileSync } from "node:fs"',
  "",
  "// The whole suite as CI runs it, on the slow CI clock: its exit code.",
  "function ciSuite() {",
  '  return Bun.spawnSync(["bun", "test", "--preload", "./ci/slow-clock.ts", "./test"], { stdout: "ignore", stderr: "ignore" }).exitCode',
  "}",
  "void existsSync, readFileSync, ciSuite, setSystemTime, expect",
  "",
].join("\n")

/** Where every task starts: week 0 plus the reference solution of every task before it, and what has arrived since. */
export function startOf(index: number): { files: Files; binary: Readonly<Record<string, Uint8Array>> } {
  return TASKS.slice(0, index).reduce(
    (state, task) => ({
      files: solve(state.files, task),
      binary: { ...state.binary, ...(task.arrives ?? {}) },
    }),
    { files: BASE as Files, binary: (TASKS[index]?.arrives ?? {}) as Readonly<Record<string, Uint8Array>> },
  )
}

/** A task's reference solution: every fact known, the dependency added the pnpm way. */
export function solve(files: Files, task: Task): Files {
  const changed = apply(files, task.changes(files, () => true))
  return task.dependency ? withDependency(changed, task.dependency) : changed
}

export function apply(files: Files, changes: readonly Change[]): Files {
  return changes.reduce<Files>((state, change) => {
    if ("content" in change) return { ...state, [change.path]: change.content }
    const before = state[change.path]
    if (before === undefined || !before.includes(change.from)) throw new Error(`${change.path} has no "${change.from}"`)
    return { ...state, [change.path]: before.replace(change.from, change.to) }
  }, files)
}

/** package.json and pnpm-lock.yaml with a dependency added, as `pnpm add` leaves them. */
export function withDependency(files: Files, name: string): Files {
  const version = JSON.parse(REGISTRY[name]!["package.json"]!).version as string
  const manifest = JSON.parse(files["package.json"]!)
  manifest.dependencies = { ...manifest.dependencies, [name]: `^${version}` }
  const deps = Object.keys(manifest.dependencies).toSorted()
  return {
    ...files,
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "pnpm-lock.yaml": `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${deps
      .map((dep) => `      ${dep}:\n        specifier: ${manifest.dependencies[dep]}\n        version: ${manifest.dependencies[dep].slice(1)}`)
      .join("\n")}\n`,
  }
}

function route(line: string): Change {
  return {
    path: "src/routes.ts",
    from: "] as const",
    to: `${line}\n] as const`,
  }
}

function pnpmFact(dependency: string) {
  return [
    'test("fact:pnpm", () => {',
    '  expect(existsSync("package-lock.json")).toBe(false)',
    `  expect(JSON.parse(readFileSync("package.json", "utf8")).dependencies["${dependency}"]).toBeDefined()`,
    `  expect(readFileSync("pnpm-lock.yaml", "utf8")).toContain("${dependency}:")`,
    "})",
  ].join("\n")
}

function routesFact(path: string) {
  return [
    'test("fact:routes", () => {',
    '  expect(Bun.spawnSync(["bun", "script/check.ts"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0)',
    `  expect(readFileSync("src/generated/routes.gen.ts", "utf8")).toContain(${JSON.stringify(path)})`,
    "})",
  ].join("\n")
}

function eventsFact(files: readonly string[]) {
  return [
    'test("fact:events", () => {',
    `  const names = ${JSON.stringify(files)}.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/emit\\("([^"]+)"/g)].map((match) => match[1]))`,
    "  expect(names.length).toBeGreaterThan(0)",
    "  for (const name of names) expect(name).toMatch(/^[a-z]+(?:_[a-z]+)*\\.[a-z]+(?:_[a-z]+)*$/)",
    "})",
  ].join("\n")
}
