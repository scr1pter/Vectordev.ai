import type { ScoringSpec, TaskCategory } from "./score"

// The task set. Every fixture is written to a fresh temp directory by run.ts,
// so a task never depends on the network, on an external repository, or on
// anything installed beyond bun and git. Fixtures deliberately have zero
// dependencies: `bun test` is the whole toolchain, which keeps the objective
// check fast and keeps a failing check attributable to the agent rather than to
// a package install.

export type ContentAssertion = {
  path: string
  exists?: boolean
  includes?: string[]
  excludes?: string[]
}

// A seeded defect used to measure whether tests the agent wrote actually bite.
// The harness applies one at a time, re-runs the check, and expects it to fail.
export type Mutation = {
  id: string
  path: string
  find: string
  replace: string
}

export type EvalTask = {
  id: string
  category: TaskCategory
  title: string
  prompt: string
  timeoutMs: number
  files: Record<string, string>
  // Must exit 0 for the task to count as passed. This is the same idea as
  // desktop's detectWorkspaceChecks/validateWorkspace, except the task declares
  // its check up front instead of the harness guessing one, so the pass bar is
  // fixed before any agent sees the repository.
  check: { command: string; args: string[] }
  expectedFiles: string[]
  // Changing any of these invalidates the run outright — they are the files
  // that define what "passed" means.
  protectedFiles: string[]
  assertions: ContentAssertion[]
  mutations: Mutation[]
}

const PACKAGE_JSON = (name: string) =>
  JSON.stringify({ name, version: "0.0.0", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) +
  "\n"

const GITIGNORE = "node_modules\n"

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
      },
    },
    null,
    2,
  ) + "\n"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export const TASKS: EvalTask[] = [
  {
    id: "bugfix-overdue-invoices",
    category: "bug-fix",
    title: "Fix an off-by-one boundary bug exposed by a failing test",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "This repository has a failing test suite. Run `bun test` to see it.",
      "Find the bug in the source code and fix it so the whole suite passes.",
      "",
      "Constraints:",
      "- Do not edit anything under test/. The tests define the expected behaviour and are correct.",
      "- Do not add dependencies or configuration files.",
      "- Change as little as possible.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-overdue-invoices"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/invoice.ts": `export type Invoice = { id: string; total: number; dueOn: string; paidOn?: string }

// Dates are ISO yyyy-mm-dd strings so they compare correctly as plain strings.
export function overdueInvoices(invoices: Invoice[], today: string) {
  return invoices.filter((invoice) => !invoice.paidOn && invoice.dueOn <= today)
}

export function overdueTotal(invoices: Invoice[], today: string) {
  return overdueInvoices(invoices, today).reduce((total, invoice) => total + invoice.total, 0)
}
`,
      "test/invoice.test.ts": `import { test, expect } from "bun:test"
import { overdueInvoices, overdueTotal, type Invoice } from "../src/invoice"

const invoices: Invoice[] = [
  { id: "a", total: 100, dueOn: "2026-01-01" },
  { id: "b", total: 250, dueOn: "2026-03-15" },
  { id: "c", total: 75, dueOn: "2025-12-01", paidOn: "2025-12-20" },
]

test("an invoice due today is not overdue yet", () => {
  expect(overdueInvoices(invoices, "2026-03-15").map((invoice) => invoice.id)).toEqual(["a"])
})

test("paid invoices are never overdue", () => {
  expect(overdueInvoices(invoices, "2026-06-01").map((invoice) => invoice.id)).toEqual(["a", "b"])
})

test("the overdue total sums only overdue invoices", () => {
  expect(overdueTotal(invoices, "2026-03-16")).toBe(350)
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/invoice.ts"],
    protectedFiles: ["test/invoice.test.ts"],
    assertions: [],
    mutations: [],
  },

  {
    id: "feature-retry-schedule",
    category: "feature",
    title: "Implement a new export against a provided specification test",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "test/backoff.test.ts specifies a `retrySchedule` export that src/backoff.ts does not have yet,",
      "so the suite currently fails to even import the module.",
      "",
      "Implement `retrySchedule` in src/backoff.ts so that `bun test` passes.",
      "The tests are the specification — read them and satisfy them exactly.",
      "",
      "Constraints:",
      "- Do not edit anything under test/.",
      "- Do not add dependencies.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-retry-schedule"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/backoff.ts": `export type BackoffOptions = {
  baseMs?: number
  factor?: number
  maxMs?: number
  budgetMs?: number
}

export function delayFor(attempt: number, options: BackoffOptions = {}) {
  const base = options.baseMs ?? 100
  const factor = options.factor ?? 2
  const max = options.maxMs ?? 10_000
  return Math.min(max, base * factor ** attempt)
}
`,
      "test/backoff.test.ts": `import { test, expect } from "bun:test"
import { delayFor, retrySchedule } from "../src/backoff"

test("delayFor grows exponentially and clamps at maxMs", () => {
  expect(delayFor(0)).toBe(100)
  expect(delayFor(3)).toBe(800)
  expect(delayFor(10)).toBe(10_000)
})

test("retrySchedule returns one delay per attempt", () => {
  expect(retrySchedule(4)).toEqual([100, 200, 400, 800])
})

test("retrySchedule stops once the cumulative budget is spent", () => {
  expect(retrySchedule(6, { budgetMs: 700 })).toEqual([100, 200, 400])
})

test("retrySchedule honours the backoff options", () => {
  expect(retrySchedule(3, { baseMs: 50, factor: 3 })).toEqual([50, 150, 450])
})

test("retrySchedule returns an empty schedule for zero attempts", () => {
  expect(retrySchedule(0)).toEqual([])
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/backoff.ts"],
    protectedFiles: ["test/backoff.test.ts"],
    assertions: [],
    mutations: [],
  },

  {
    id: "refactor-rename-symbol",
    category: "refactor",
    title: "Rename an exported symbol across four files with no behaviour change",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "Rename the exported function `computeTotal` in src/pricing.ts to `calculateOrderTotal`,",
      "and update every reference to it across the repository.",
      "",
      "Constraints:",
      "- Behaviour must not change: `bun test` must still pass.",
      "- Leave no compatibility alias behind. The name `computeTotal` must not appear anywhere in src/ when you are done.",
      "- Do not edit anything under test/.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-rename-symbol"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/pricing.ts": `export type OrderLine = { sku: string; quantity: number; unitCents: number }

export function computeTotal(lines: OrderLine[], taxRate: number) {
  const subtotal = lines.reduce((total, line) => total + line.quantity * line.unitCents, 0)
  return subtotal + Math.round(subtotal * taxRate)
}
`,
      "src/checkout.ts": `import { computeTotal, type OrderLine } from "./pricing"

export function checkout(lines: OrderLine[], taxRate: number) {
  return { lineCount: lines.length, totalCents: computeTotal(lines, taxRate) }
}
`,
      "src/report.ts": `import { computeTotal, type OrderLine } from "./pricing"

export function summarize(orders: OrderLine[][], taxRate: number) {
  return {
    orders: orders.length,
    revenueCents: orders.reduce((total, lines) => total + computeTotal(lines, taxRate), 0),
  }
}
`,
      "src/index.ts": `export { checkout } from "./checkout"
export { summarize } from "./report"
export { computeTotal } from "./pricing"
export type { OrderLine } from "./pricing"
`,
      "test/checkout.test.ts": `import { test, expect } from "bun:test"
import { checkout, summarize } from "../src/index"

const lines = [
  { sku: "a", quantity: 2, unitCents: 500 },
  { sku: "b", quantity: 1, unitCents: 250 },
]

test("checkout totals the lines and adds tax", () => {
  expect(checkout(lines, 0.1)).toEqual({ lineCount: 2, totalCents: 1375 })
})

test("summarize adds up every order", () => {
  expect(summarize([lines, lines], 0)).toEqual({ orders: 2, revenueCents: 2500 })
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/pricing.ts", "src/checkout.ts", "src/report.ts", "src/index.ts"],
    protectedFiles: ["test/checkout.test.ts"],
    assertions: [
      { path: "src/pricing.ts", includes: ["calculateOrderTotal"], excludes: ["computeTotal"] },
      { path: "src/checkout.ts", includes: ["calculateOrderTotal"], excludes: ["computeTotal"] },
      { path: "src/report.ts", includes: ["calculateOrderTotal"], excludes: ["computeTotal"] },
      { path: "src/index.ts", includes: ["calculateOrderTotal"], excludes: ["computeTotal"] },
    ],
    mutations: [],
  },

  {
    id: "discipline-single-file-fix",
    category: "bug-fix",
    title: "Fix one line without touching any of the tempting unrelated files",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "One test in this repository fails. Run `bun test` to see it, then fix it.",
      "",
      "Constraints:",
      "- Change exactly one file: src/parse-args.ts.",
      "- Leave every other file byte-for-byte identical, even if you notice unrelated problems,",
      "  stale documentation, typos, or missing tests. Do not fix them and do not mention them in a file.",
      "- Do not add dependencies or configuration files.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-parse-args"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "README.md": `# parse-args

A tiny argument parser used by our internal tooling.

## Useage

Run the parser over process.argv.slice(2). Flags are returned as strings; a flag
with no value is returned as the string "true".

TODO: document the --key=value form.
`,
      "docs/usage.md": `# Usage

The parser supports two flag forms:

- --key value
- --key=value

Positional arguments are returned in the order they appeared.

Note: this document is known to be ahead of the implementation.
`,
      "src/parse-args.ts": `export type ParsedArgs = { flags: Record<string, string>; positional: string[] }

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      flags[token.slice(2)] = next
      index++
      continue
    }
    flags[token.slice(2)] = "true"
  }
  return { flags, positional }
}
`,
      "src/logger.ts": `export type Level = "debug" | "info" | "warn" | "error"

// TODO: this always logs at info and ignores the level argument.
export function log(_level: Level, message: string) {
  console.log(message)
}
`,
      "src/config.ts": `export type Config = { root: string; watch: boolean }

export function defaultConfig(): Config {
  return { root: process.cwd(), watch: false }
}
`,
      "src/normalize.ts": `export function normalizeKey(key: string) {
  return key.trim().toLowerCase().replace("_", "-")
}
`,
      "test/parse-args.test.ts": `import { test, expect } from "bun:test"
import { parseArgs } from "../src/parse-args"

test("parses the --key value form", () => {
  expect(parseArgs(["--model", "gpt"])).toEqual({ flags: { model: "gpt" }, positional: [] })
})

test("parses the --key=value form", () => {
  expect(parseArgs(["--model=gpt", "run"])).toEqual({ flags: { model: "gpt" }, positional: ["run"] })
})

test("treats a trailing flag as a boolean", () => {
  expect(parseArgs(["--watch"])).toEqual({ flags: { watch: "true" }, positional: [] })
})

test("keeps positional arguments in order", () => {
  expect(parseArgs(["run", "build"])).toEqual({ flags: {}, positional: ["run", "build"] })
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/parse-args.ts"],
    protectedFiles: ["test/parse-args.test.ts"],
    assertions: [],
    mutations: [],
  },

  {
    id: "test-writing-parse-duration",
    category: "test-writing",
    title: "Write tests that actually catch seeded defects",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "src/duration.ts has no tests. Write them in test/duration.test.ts so that `bun test` passes.",
      "",
      "parseDuration takes a compact duration string and returns milliseconds:",
      '- Single units: "500ms", "90s", "5m", "2h", "1d".',
      '- Composite units with no separator: "2h30m", "1d12h".',
      "- Input is trimmed and lowercased before parsing.",
      '- Anything it cannot parse in full returns undefined: "", "5", "5x", "m5", and forms with internal',
      '  whitespace such as "1h 30m".',
      "",
      "Constraints:",
      "- Do not edit src/duration.ts. Test the behaviour that is there, including the cases it rejects.",
      "- Do not add dependencies. Use bun:test.",
      "",
      "Your tests are scored on whether they would catch a defect introduced into src/duration.ts later,",
      "so cover each unit and each rejection case, not just the happy path.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-parse-duration"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/duration.ts": `const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

// Parses a compact duration ("90s", "2h30m", "1d") into milliseconds. Returns
// undefined unless the whole input is consumed, so partially valid input like
// "5m junk" is rejected rather than silently truncated.
export function parseDuration(input: string) {
  const normalized = input.trim().toLowerCase()
  const matches = normalized.match(/\\d+(ms|s|m|h|d)/g)
  if (!matches) return undefined
  if (matches.join("") !== normalized) return undefined
  return matches.reduce((total, part) => {
    const unit = part.replace(/^\\d+/, "")
    return total + Number(part.slice(0, part.length - unit.length)) * UNITS[unit]!
  }, 0)
}
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["test/**"],
    protectedFiles: ["src/duration.ts"],
    assertions: [{ path: "test/duration.test.ts", exists: true, includes: ["parseDuration"] }],
    mutations: [
      { id: "seconds-unit", path: "src/duration.ts", find: "s: 1000,", replace: "s: 1100," },
      { id: "hours-unit", path: "src/duration.ts", find: "h: 3_600_000,", replace: "h: 3_600_00," },
      {
        id: "accepts-unparseable",
        path: "src/duration.ts",
        find: "if (!matches) return undefined",
        replace: "if (!matches) return 0",
      },
      {
        id: "accepts-partial-input",
        path: "src/duration.ts",
        find: 'if (matches.join("") !== normalized) return undefined',
        replace: 'if (matches.join("") !== normalized && false) return undefined',
      },
    ],
  },

  {
    id: "bugfix-idempotent-webhooks",
    category: "bug-fix",
    title: "Make a billing projection duplicate-safe and order-safe",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "The entitlement projection in src/entitlements.ts mishandles webhook delivery semantics.",
      "Run `bun test`, then fix the implementation so duplicate events have no effect and an older",
      "subscription update cannot overwrite newer subscription state.",
      "",
      "Constraints:",
      "- Do not edit anything under test/.",
      "- Do not add dependencies.",
      "- Keep invoice credit grants independent from subscription event ordering.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-idempotent-webhooks"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/entitlements.ts": `export type BillingEvent =
  | { id: string; created: number; type: "invoice.paid"; credits: number }
  | { id: string; created: number; type: "subscription.updated"; active: boolean }

export type EntitlementState = {
  active: boolean
  credits: number
  lastSubscriptionEventAt: number
  processedEventIds: string[]
}

export const emptyEntitlement = (): EntitlementState => ({
  active: false,
  credits: 0,
  lastSubscriptionEventAt: 0,
  processedEventIds: [],
})

export function applyBillingEvent(state: EntitlementState, event: BillingEvent): EntitlementState {
  if (event.type === "invoice.paid") {
    return {
      ...state,
      credits: state.credits + event.credits,
      processedEventIds: [...state.processedEventIds, event.id],
    }
  }
  return {
    ...state,
    active: event.active,
    lastSubscriptionEventAt: event.created,
    processedEventIds: [...state.processedEventIds, event.id],
  }
}
`,
      "test/entitlements.test.ts": `import { expect, test } from "bun:test"
import { applyBillingEvent, emptyEntitlement } from "../src/entitlements"

test("a retried invoice webhook grants credits exactly once", () => {
  const event = { id: "evt_invoice", created: 20, type: "invoice.paid" as const, credits: 500 }
  const once = applyBillingEvent(emptyEntitlement(), event)
  expect(applyBillingEvent(once, event)).toEqual(once)
})

test("an older subscription event cannot roll back newer state", () => {
  const active = applyBillingEvent(emptyEntitlement(), {
    id: "evt_new",
    created: 200,
    type: "subscription.updated",
    active: true,
  })
  expect(
    applyBillingEvent(active, {
      id: "evt_old",
      created: 100,
      type: "subscription.updated",
      active: false,
    }),
  ).toEqual({ ...active, processedEventIds: [...active.processedEventIds, "evt_old"] })
})

test("invoice grants are accepted even when their timestamps are older", () => {
  const current = applyBillingEvent(emptyEntitlement(), {
    id: "evt_subscription",
    created: 200,
    type: "subscription.updated",
    active: true,
  })
  const credited = applyBillingEvent(current, {
    id: "evt_invoice",
    created: 50,
    type: "invoice.paid",
    credits: 250,
  })
  expect(credited.credits).toBe(250)
  expect(credited.active).toBe(true)
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/entitlements.ts"],
    protectedFiles: ["test/entitlements.test.ts"],
    assertions: [],
    mutations: [],
  },

  {
    id: "security-path-containment",
    category: "bug-fix",
    title: "Close a sibling-prefix path traversal bug",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "resolveWorkspacePath is intended to reject every path outside its workspace root, but the tests expose",
      "a containment bug. Run `bun test` and make the smallest robust fix in src/workspace-path.ts.",
      "",
      "Constraints:",
      "- Do not edit anything under test/.",
      "- Do not add dependencies.",
      "- The root itself and genuinely nested paths must remain valid.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-path-containment"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/workspace-path.ts": `import { resolve } from "node:path"

export function resolveWorkspacePath(root: string, candidate: string) {
  const workspace = resolve(root)
  const target = resolve(workspace, candidate)
  if (!target.startsWith(workspace)) throw new Error("Path escapes the workspace")
  return target
}
`,
      "test/workspace-path.test.ts": `import { expect, test } from "bun:test"
import { resolveWorkspacePath } from "../src/workspace-path"

test("accepts the root and nested files", () => {
  expect(resolveWorkspacePath("/tmp/vector/project", ".")).toBe("/tmp/vector/project")
  expect(resolveWorkspacePath("/tmp/vector/project", "src/index.ts")).toBe("/tmp/vector/project/src/index.ts")
})

test("rejects parent traversal", () => {
  expect(() => resolveWorkspacePath("/tmp/vector/project", "../secret.txt")).toThrow("escapes")
})

test("rejects a sibling whose name merely shares the root prefix", () => {
  expect(() => resolveWorkspacePath("/tmp/vector/project", "../project-secrets/token.txt")).toThrow("escapes")
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/workspace-path.ts"],
    protectedFiles: ["test/workspace-path.test.ts"],
    assertions: [],
    mutations: [],
  },

  {
    id: "bugfix-concurrent-reservations",
    category: "bug-fix",
    title: "Prevent concurrent model requests from overspending one allowance",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: [
      "CreditLedger.reserve has a race that lets concurrent model requests reserve more than the account balance.",
      "Run `bun test`, diagnose the interleaving, and fix the source with the smallest clear change.",
      "",
      "Constraints:",
      "- Do not edit anything under test/.",
      "- Do not add dependencies.",
      "- Preserve the public API and the refund behaviour.",
    ].join("\n"),
    files: {
      "package.json": PACKAGE_JSON("eval-concurrent-reservations"),
      ".gitignore": GITIGNORE,
      "tsconfig.json": TSCONFIG,
      "src/credit-ledger.ts": `export class CreditLedger {
  #used = 0

  constructor(readonly allowance: number) {}

  get used() {
    return this.#used
  }

  async reserve(amount: number) {
    if (amount <= 0 || this.#used + amount > this.allowance) return false
    await Promise.resolve()
    this.#used += amount
    return true
  }

  refund(amount: number) {
    this.#used = Math.max(0, this.#used - amount)
  }
}
`,
      "test/credit-ledger.test.ts": `import { expect, test } from "bun:test"
import { CreditLedger } from "../src/credit-ledger"

test("one request cannot reserve beyond the allowance", async () => {
  const ledger = new CreditLedger(100)
  expect(await ledger.reserve(101)).toBe(false)
  expect(ledger.used).toBe(0)
})

test("concurrent reservations cannot overspend", async () => {
  const ledger = new CreditLedger(100)
  const results = await Promise.all([ledger.reserve(70), ledger.reserve(70)])
  expect(results.filter(Boolean)).toHaveLength(1)
  expect(ledger.used).toBe(70)
})

test("a refund makes the released allowance available again", async () => {
  const ledger = new CreditLedger(100)
  expect(await ledger.reserve(80)).toBe(true)
  ledger.refund(30)
  expect(await ledger.reserve(50)).toBe(true)
  expect(ledger.used).toBe(100)
})
`,
    },
    check: { command: "bun", args: ["test"] },
    expectedFiles: ["src/credit-ledger.ts"],
    protectedFiles: ["test/credit-ledger.test.ts"],
    assertions: [],
    mutations: [],
  },
]

export function taskById(id: string) {
  return TASKS.find((task) => task.id === id)
}

export function scoringSpec(task: EvalTask): ScoringSpec {
  return {
    id: task.id,
    category: task.category,
    expectedFiles: task.expectedFiles,
    mutationCount: task.mutations.length,
  }
}
