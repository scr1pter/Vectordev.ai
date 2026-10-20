// The repository the compounding benchmark works in: "ledger", a small invoicing and refunds service. It starts as the
// files below (week 0); every task then starts from week 0 plus the reference solutions of the tasks before it, so both
// arms always start a task from the same files whatever they did earlier. It has no dependencies on the network: the
// package managers on its PATH are stand-ins (bin/pm.ts) that install from a local registry folder.

import { pdf } from "../../../packages/core/test/brain/fixture/pdf"

export const BASE: Record<string, string> = {
  ".gitignore": "node_modules/\n.acceptance/\n",
  "package.json": `${JSON.stringify(
    {
      name: "ledger",
      private: true,
      type: "module",
      packageManager: "pnpm@9.12.0",
      scripts: {
        test: "bun test",
        "test:ci": "bun test --preload ./ci/slow-clock.ts",
        check: "bun script/check.ts",
        gen: "bun script/gen-routes.ts",
      },
      dependencies: {},
    },
    null,
    2,
  )}\n`,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n",
  "README.md": [
    "# ledger",
    "",
    "Invoices, orders and refunds for the shop's back office.",
    "",
    "Before you finish a change, run the tests and the `check` script; CI runs both.",
    "",
  ].join("\n"),
  "CONTRIBUTING.md": [
    "# Contributing",
    "",
    "We use pnpm (see `packageManager` in package.json). Never run npm here: it writes a package-lock.json, and the",
    "check rejects it. Add a dependency with `pnpm add <name>`.",
    "",
  ].join("\n"),
  "ci/slow-clock.ts": [
    "// CI machines are shared and slow. This preload plays that back on any machine: every read of the clock is a",
    "// quarter of a second after the last one, as a loaded runner can be.",
    "const real = Date.now",
    "let lag = 0",
    "Date.now = () => real() + (lag += 250)",
    "",
  ].join("\n"),
  "script/check.ts": [
    "// The CI gate every change must pass besides the tests.",
    'import { createHash } from "node:crypto"',
    'import { existsSync, readFileSync } from "node:fs"',
    "",
    "const failures: string[] = []",
    'if (existsSync("package-lock.json"))',
    "  failures.push(",
    '    "package-lock.json found. This repository uses pnpm (see CONTRIBUTING.md): delete package-lock.json and install with pnpm.",',
    "  )",
    'const source = readFileSync("src/routes.ts", "utf8")',
    'const hash = createHash("sha256").update(source).digest("hex").slice(0, 12)',
    'const generated = existsSync("src/generated/routes.gen.ts") ? readFileSync("src/generated/routes.gen.ts", "utf8") : ""',
    "if (!generated.includes(`// source: ${hash}`))",
    '  failures.push("src/generated/routes.gen.ts is stale. Run `pnpm gen` after changing src/routes.ts.")',
    "if (failures.length > 0) {",
    '  console.error(["check failed:", ...failures.map((failure) => `- ${failure}`)].join("\\n"))',
    "  process.exit(1)",
    "}",
    'console.log("check ok")',
    "",
  ].join("\n"),
  "script/gen-routes.ts": [
    "// Writes src/generated/routes.gen.ts from src/routes.ts: the route table the HTTP server loads.",
    'import { createHash } from "node:crypto"',
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs"',
    "",
    'const source = readFileSync("src/routes.ts", "utf8")',
    'const hash = createHash("sha256").update(source).digest("hex").slice(0, 12)',
    "const table = Object.fromEntries(",
    '  [...source.matchAll(/method: "(\\w+)", path: "([^"]+)", handler: "(\\w+)"/g)].map((match) => [`${match[1]} ${match[2]}`, match[3]]),',
    ")",
    'mkdirSync("src/generated", { recursive: true })',
    "writeFileSync(",
    '  "src/generated/routes.gen.ts",',
    "  `// Generated from src/routes.ts by \\`pnpm gen\\`. Do not edit.\\n// source: ${hash}\\nexport const ROUTE_TABLE = ${JSON.stringify(table, null, 2)} as const\\n`,",
    ")",
    'console.log(`routes.gen.ts: ${Object.keys(table).length} routes`)',
    "",
  ].join("\n"),
  "src/events.ts": [
    "export type Event = { name: string; payload: Record<string, unknown> }",
    "",
    "/** What was emitted, in order; the outbox worker drains it. */",
    "export const emitted: Event[] = []",
    "",
    "export function emit(name: string, payload: Record<string, unknown> = {}) {",
    "  emitted.push({ name, payload })",
    "}",
    "",
  ].join("\n"),
  "src/money.ts": ["export function formatAmount(amount: number) {", "  return `$${amount.toFixed(2)}`", "}", ""].join("\n"),
  "src/invoice.ts": [
    'import { emit } from "./events"',
    "",
    "export type Invoice = { id: string; amount: number; dueOn: string; paidOn?: string }",
    "",
    "export function lateFee(invoice: Invoice) {",
    "  return invoice.amount * 0.02",
    "}",
    "",
    "export function markPaid(invoice: Invoice, paidOn: string): Invoice {",
    '  emit("INVOICE_PAID", { id: invoice.id })',
    "  return { ...invoice, paidOn }",
    "}",
    "",
  ].join("\n"),
  "src/orders.ts": [
    "export type Order = { id: string; customer: string; amount: number; capturedOn: string }",
    "",
    "export function orderTotal(lines: { amount: number; quantity: number }[]) {",
    "  return lines.reduce((sum, line) => sum + line.amount * line.quantity, 0)",
    "}",
    "",
  ].join("\n"),
  "src/routes.ts": [
    "// Every HTTP route the API serves.",
    "export const routes = [",
    '  { method: "GET", path: "/invoices/:id", handler: "getInvoice" },',
    '  { method: "POST", path: "/invoices/:id/pay", handler: "payInvoice" },',
    "] as const",
    "",
  ].join("\n"),
  "src/clock.ts": [
    "export type Clock = { now: () => number }",
    "",
    "export const systemClock: Clock = { now: () => Date.now() }",
    "",
    "/** A clock that only moves when told to, for tests. */",
    "export function createClock(start = 0) {",
    "  let time = start",
    "  return { now: () => time, advance: (ms: number) => void (time += ms) }",
    "}",
    "",
  ].join("\n"),
  "src/session.ts": [
    'import { systemClock, type Clock } from "./clock"',
    "",
    "export type Token = { value: string; expiresAt: number }",
    "",
    "export function issueToken(input: { ttlMs: number; clock?: Clock }): Token {",
    "  const clock = input.clock ?? systemClock",
    "  return { value: crypto.randomUUID(), expiresAt: clock.now() + input.ttlMs }",
    "}",
    "",
    "export function isExpired(token: Token, clock: Clock = systemClock) {",
    "  return clock.now() >= token.expiresAt",
    "}",
    "",
  ].join("\n"),
  "test/invoice.test.ts": [
    'import { expect, test } from "bun:test"',
    'import { emitted } from "../src/events"',
    'import { lateFee, markPaid } from "../src/invoice"',
    "",
    'test("the late fee is 2% of the amount", () => {',
    '  expect(lateFee({ id: "a", amount: 100, dueOn: "2026-03-01" })).toBe(2)',
    "})",
    "",
    'test("paying an invoice records the payment", () => {',
    '  const paid = markPaid({ id: "b", amount: 100, dueOn: "2026-03-01" }, "2026-03-02")',
    '  expect(paid.paidOn).toBe("2026-03-02")',
    '  expect(emitted.at(-1)?.name).toBe("INVOICE_PAID")',
    "})",
    "",
  ].join("\n"),
  "test/orders.test.ts": [
    'import { expect, test } from "bun:test"',
    'import { orderTotal } from "../src/orders"',
    "",
    'test("an order total adds up its lines", () => {',
    "  expect(orderTotal([{ amount: 250, quantity: 2 }, { amount: 100, quantity: 1 }])).toBe(600)",
    "})",
    "",
  ].join("\n"),
  "test/session.test.ts": [
    'import { expect, test } from "bun:test"',
    'import { isExpired, issueToken } from "../src/session"',
    "",
    'test("a fresh token is not expired", () => {',
    "  const token = issueToken({ ttlMs: 200 })",
    "  expect(isExpired(token)).toBe(false)",
    "})",
    "",
    'test("a token expires after its ttl", async () => {',
    "  const token = issueToken({ ttlMs: 20 })",
    "  await Bun.sleep(30)",
    "  expect(isExpired(token)).toBe(true)",
    "})",
    "",
  ].join("\n"),
}

// script/check.ts after a teammate's change in week 7: the check writes the route table itself, so the table can no
// longer go stale and the gen script is gone (tasks.ts removes it from package.json).
export const REGENERATING_CHECK = [
  "// The CI gate every change must pass besides the tests. It writes src/generated/routes.gen.ts from src/routes.ts",
  "// itself, so the route table can no longer go stale.",
  'import { existsSync } from "node:fs"',
  "",
  "const failures: string[] = []",
  'if (existsSync("package-lock.json"))',
  "  failures.push(",
  '    "package-lock.json found. This repository uses pnpm (see CONTRIBUTING.md): delete package-lock.json and install with pnpm.",',
  "  )",
  'const generated = Bun.spawnSync(["bun", "script/gen-routes.ts"], { stdout: "ignore", stderr: "pipe" })',
  "if (generated.exitCode !== 0) failures.push(`script/gen-routes.ts failed: ${generated.stderr.toString().trim()}`)",
  "if (failures.length > 0) {",
  '  console.error(["check failed:", ...failures.map((failure) => `- ${failure}`)].join("\\n"))',
  "  process.exit(1)",
  "}",
  'console.log("check ok")',
  "",
].join("\n")

// Packages the stand-in package managers install. Each is a tiny ES module, so a test that imports one runs offline.
export const REGISTRY: Record<string, Record<string, string>> = {
  "tiny-slug": {
    "package.json": JSON.stringify({ name: "tiny-slug", version: "1.2.0", type: "module", main: "index.js" }),
    "index.js":
      'export default function slug(text) {\n  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")\n}\n',
  },
  "tiny-csv": {
    "package.json": JSON.stringify({ name: "tiny-csv", version: "0.4.1", type: "module", main: "index.js" }),
    "index.js":
      'const cell = (value) => (/[",\\n]/.test(String(value)) ? `"${String(value).replaceAll(\'"\', \'""\')}"` : String(value))\nexport function stringify(rows) {\n  return rows.map((row) => row.map(cell).join(",")).join("\\n") + "\\n"\n}\n',
  },
  "tiny-pdf": {
    "package.json": JSON.stringify({ name: "tiny-pdf", version: "2.0.3", type: "module", main: "index.js" }),
    "index.js":
      'export function render(lines) {\n  return `%PDF-1.4\\n% tiny-pdf\\n${lines.map((line) => `(${line}) Tj`).join("\\n")}\\n%%EOF\\n`\n}\n',
  },
}

// The stand-in for npm and pnpm the agent's shell finds first on its PATH. It runs package scripts and installs from
// REGISTRY; npm writes the package-lock.json a pnpm repository's check rejects, as the real one would. It never reaches
// the network or a real package manager.
export const PACKAGE_MANAGER = `
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [tool, ...args] = process.argv.slice(2)
const registry = process.env.LEDGER_REGISTRY ?? ""
const manifest = JSON.parse(readFileSync("package.json", "utf8"))
const scripts = manifest.scripts ?? {}

function install(names) {
  const missing = names.filter((name) => !existsSync(join(registry, name)))
  if (missing.length) {
    console.error(\`\${tool} ERR! 404 Not Found: \${missing.join(", ")} is not in the registry\`)
    process.exit(1)
  }
  for (const name of names) {
    const version = JSON.parse(readFileSync(join(registry, name, "package.json"), "utf8")).version
    cpSync(join(registry, name), join("node_modules", name), { recursive: true })
    manifest.dependencies = { ...manifest.dependencies, [name]: \`^\${version}\` }
  }
  writeFileSync("package.json", JSON.stringify(manifest, null, 2) + "\\n")
  const deps = Object.keys(manifest.dependencies ?? {}).sort()
  if (tool === "npm") {
    const packages = Object.fromEntries(deps.map((name) => [\`node_modules/\${name}\`, { version: manifest.dependencies[name].slice(1) }]))
    writeFileSync("package-lock.json", JSON.stringify({ name: manifest.name, lockfileVersion: 3, packages }, null, 2) + "\\n")
    console.log(\`added \${names.length} package\${names.length === 1 ? "" : "s"}, and audited \${deps.length + 1} packages in 1s\\n\\nfound 0 vulnerabilities\`)
    return
  }
  const lines = deps.map((name) => \`      \${name}:\\n        specifier: \${manifest.dependencies[name]}\\n        version: \${manifest.dependencies[name].slice(1)}\`)
  writeFileSync("pnpm-lock.yaml", \`lockfileVersion: '9.0'\\n\\nimporters:\\n\\n  .:\\n    dependencies:\\n\${lines.join("\\n")}\\n\`)
  console.log(\`Packages: +\${names.length}\\nProgress: resolved \${names.length}, reused \${names.length}, downloaded 0, added \${names.length}, done\\n\\ndependencies:\\n\${names.map((name) => \`+ \${name}\`).join("\\n")}\\n\\nDone in 0.4s\`)
}

function run(script, rest) {
  if (!scripts[script]) {
    console.error(tool === "npm" ? \`npm error Missing script: "\${script}"\` : \`ERR_PNPM_NO_SCRIPT  Missing script: \${script}\`)
    process.exit(1)
  }
  console.log(\`\\n> \${manifest.name} \${script}\\n> \${scripts[script]}\\n\`)
  const child = Bun.spawnSync(["sh", "-c", [scripts[script], ...rest].join(" ")], { stdout: "inherit", stderr: "inherit" })
  process.exit(child.exitCode ?? 1)
}

const [command, ...rest] = args
const packages = rest.filter((word) => !word.startsWith("-"))
if (command === "add" || ((command === "install" || command === "i") && packages.length > 0)) install(packages)
else if (command === "install" || command === "i") install([])
else if (command === "test" || command === "t") run("test", rest)
else if (command === "run" || command === "run-script") run(rest[0] ?? "", rest.slice(1))
else if (tool === "pnpm" && command && scripts[command]) run(command, rest)
else {
  console.error(tool === "npm" ? \`Unknown command: "\${command ?? ""}"\` : \`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "\${command ?? ""}" not found\`)
  process.exit(1)
}
`

/**
 * The refund policy the owner uploads in week 2: a two-page engineering spec. Generated, so no binary is committed. Its
 * sentences are the facts later tasks need; the code never states the email subject or the HTTP header.
 */
export function refundPolicyPdf() {
  const lines = (start: number, items: readonly { text: string; size?: number; font?: "bold" | "regular" | "mono" }[]) =>
    items.map((item, index) => ({ ...item, x: 72, y: start - index * 22 }))
  return pdf({
    title: "Refund policy",
    outline: [
      { title: "1 Scope", page: 1 },
      { title: "2 Refund window", page: 1 },
      { title: "3 Idempotency", page: 1 },
      { title: "4 Customer email", page: 2 },
    ],
    pages: [
      {
        runs: lines(720, [
          { text: "Refund policy: engineering spec v1 (October 2026)", size: 18, font: "bold" },
          { text: "1 Scope", size: 14, font: "bold" },
          { text: "This spec covers refunds of captured card orders, through requestRefund and the refunds API.", size: 11 },
          { text: "2 Refund window", size: 14, font: "bold" },
          { text: "Refunds are allowed for at most 14 days after capture, as REFUND_WINDOW_DAYS sets.", size: 11 },
          { text: "A request after the window MUST be rejected with the reason window_closed.", size: 11 },
          { text: "3 Idempotency", size: 14, font: "bold" },
          { text: "requestRefund MUST return the first refund for a repeated key instead of creating another.", size: 11 },
          { text: "POST /refunds MUST reject a request without an Idempotency-Key header with status 400.", size: 11 },
        ]),
      },
      {
        runs: lines(720, [
          { text: "4 Customer email", size: 14, font: "bold" },
          { text: "Every refund MUST send the customer one email.", size: 11 },
          { text: "The refund email subject MUST be: Your refund for order <order id>.", size: 11 },
        ]),
      },
    ],
  })
}
