import { beforeAll, afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { buildIndex, clearIndexCache, rankFiles, refreshIndex, type RepoIndex } from "./repo-index"

const scratch: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "vector-repo-index-"))
  scratch.push(root)
  for (const path of Object.keys(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), files[path]!, "utf8")
  }
  return root
}

async function git(cwd: string, args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" })
  await child.exited
}

afterAll(async () => {
  for (const root of scratch) await rm(root, { recursive: true, force: true })
})

const TYPESCRIPT_FIXTURE = {
  "src/billing/gateway.ts": `import { logger } from "../common/logging"

export class PaymentError extends Error {}

export const refundPolicy = { windowDays: 30 }

export function processPayment(amount: number) {
  logger.info("processPayment starting")
  if (amount <= 0) throw new PaymentError("amount must be positive")
  return { charged: amount, via: processPayment.name }
}
`,
  // Imports the gateway but never names processPayment, so it can only surface
  // through the import graph.
  "src/checkout/session.ts": `import { logger } from "../common/logging"
import { refundPolicy } from "../billing/gateway"

export function openSession(userId: string) {
  logger.info("session opened")
  return { userId, refundPolicy }
}
`,
  "src/analytics/report.ts": `import { logger } from "../common/logging"

// The processPayment helper was duplicated here before it moved out.
export function buildReport() {
  logger.info("report built")
  return []
}
`,
  "src/common/logging.ts": `export const logger = {
  info(message: string) {
    return \`info \${message}\`
  },
  warn(message: string) {
    return \`warn \${message}\`
  },
}

${Array.from({ length: 40 }, (_, index) => `// logger reference ${index}`).join("\n")}
`,
  "src/server/http.ts": `import { logger } from "../common/logging"
import { openSession } from "../checkout/session"

export function startServer() {
  logger.info("listening")
  return openSession("anonymous")
}
`,
  "node_modules/vendor/index.ts": `export function processPayment() {
  return "vendored processPayment"
}
`,
  "dist/bundle.js": `export function processPayment() {
  return "bundled processPayment"
}
`,
}

describe("repo index ranking", () => {
  let index: RepoIndex

  beforeAll(async () => {
    index = await buildIndex(await fixture(TYPESCRIPT_FIXTURE))
  })

  test("skips excluded directories even when they contain the searched symbol", () => {
    expect(index.files.map((file) => file.path).sort()).toEqual([
      "src/analytics/report.ts",
      "src/billing/gateway.ts",
      "src/checkout/session.ts",
      "src/common/logging.ts",
      "src/server/http.ts",
    ])
    expect(rankFiles(index, "processPayment").every((file) => !/^(?:node_modules|dist)\//.test(file.path))).toBe(true)
  })

  test("resolves relative imports into real files", () => {
    const session = index.files.find((file) => file.path === "src/checkout/session.ts")!
    expect(session.dependencies.sort()).toEqual(["src/billing/gateway.ts", "src/common/logging.ts"])
  })

  test("records symbol kind, export status and the defining line", () => {
    const gateway = index.files.find((file) => file.path === "src/billing/gateway.ts")!
    const processPayment = gateway.symbols.find((symbol) => symbol.name === "processPayment")!
    expect(processPayment.kind).toBe("function")
    expect(processPayment.exported).toBe(true)
    expect(processPayment.line).toBe(7)
    expect(gateway.symbols.find((symbol) => symbol.name === "PaymentError")?.kind).toBe("class")
    expect(gateway.symbols.find((symbol) => symbol.name === "refundPolicy")?.kind).toBe("constant")
  })

  test("ranks the defining file above a file that merely mentions the symbol", () => {
    const ranked = rankFiles(index, "processPayment")
    expect(ranked[0]!.path).toBe("src/billing/gateway.ts")
    expect(ranked[0]!.reasons.some((reason) => reason.startsWith("defines processPayment (line 7)"))).toBe(true)
    expect(ranked[0]!.symbols.some((symbol) => symbol.name === "processPayment" && symbol.line === 7)).toBe(true)

    const mention = ranked.find((file) => file.path === "src/analytics/report.ts")!
    expect(mention.score).toBeLessThan(ranked[0]!.score)
    expect(mention.reasons.some((reason) => reason.startsWith("defines"))).toBe(false)
  })

  test("pulls an importer in through graph expansion", () => {
    const session = rankFiles(index, "processPayment").find((file) => file.path === "src/checkout/session.ts")
    expect(session).toBeDefined()
    expect(session!.hops).toBeGreaterThanOrEqual(1)
    expect(session!.reasons.some((reason) => reason.includes("src/billing/gateway.ts"))).toBe(true)

    // Without expansion the importer has no lexical hit at all, which is what
    // makes it evidence that the graph rather than the text surfaced it.
    const lexicalOnly = rankFiles(index, "processPayment", { expansion: false })
    expect(lexicalOnly.some((file) => file.path === "src/checkout/session.ts")).toBe(false)
  })

  test("reaches a second hop with a damped contribution", () => {
    const ranked = rankFiles(index, "processPayment")
    const session = ranked.find((file) => file.path === "src/checkout/session.ts")!
    const http = ranked.find((file) => file.path === "src/server/http.ts")!
    expect(http.hops).toBeGreaterThan(session.hops)
    expect(http.score).toBeLessThan(session.score)
  })

  test("keeps a token present in every file from dominating the ranking", () => {
    const ranked = rankFiles(index, "processPayment logger")
    expect(ranked[0]!.path).toBe("src/billing/gateway.ts")

    // logging.ts repeats "logger" more than forty times; idf has to make that
    // worth almost nothing next to a term that occurs in two of five files.
    const logging = ranked.find((file) => file.path === "src/common/logging.ts")!
    expect(logging.score).toBeLessThan(ranked[0]!.score / 2)
  })

  test("still ranks a common token sensibly when it is the whole query", () => {
    expect(rankFiles(index, "logger")[0]!.path).toBe("src/common/logging.ts")
  })

  test("scores an explicitly named path above everything else", () => {
    const ranked = rankFiles(index, "update src/server/http.ts to log the port")
    expect(ranked[0]!.path).toBe("src/server/http.ts")
    expect(ranked[0]!.reasons).toContain("explicitly named in the task")
  })

  test("degrades silently to no co-change signal outside a git repository", () => {
    expect(index.head).toBe("")
    expect(index.coChange.size).toBe(0)
    expect(index.stats.coChangeCommits).toBe(0)
  })
})

describe("repo index incremental refresh", () => {
  test("re-parses only the files whose size or mtime changed", async () => {
    const root = await fixture(TYPESCRIPT_FIXTURE)
    // The cache belongs outside the project, the way userData does in the app;
    // inside it, the index would pick up its own cache file as a source file.
    const cacheDirectory = await fixture({})

    const first = await buildIndex(root, { cacheDirectory, coChange: false })
    expect(first.stats.parsedFiles).toBe(5)
    expect(first.stats.reusedFiles).toBe(0)

    // Dropping the in-process cache forces the next refresh through the
    // persisted mtime and size bookkeeping rather than a live object.
    clearIndexCache()
    const unchanged = await refreshIndex(root, { cacheDirectory, coChange: false })
    expect(unchanged.stats.parsedFiles).toBe(0)
    expect(unchanged.stats.reusedFiles).toBe(5)
    expect(unchanged.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path))

    await writeFile(
      join(root, "src/analytics/report.ts"),
      `export function buildReport() {\n  return ["a much shorter report module"]\n}\n`,
      "utf8",
    )
    clearIndexCache()
    const changed = await refreshIndex(root, { cacheDirectory, coChange: false })
    expect(changed.stats.parsedFiles).toBe(1)
    expect(changed.stats.reusedFiles).toBe(4)

    const report = changed.files.find((file) => file.path === "src/analytics/report.ts")!
    expect(report.dependencies).toEqual([])
    expect(rankFiles(changed, "processPayment").some((file) => file.path === "src/analytics/report.ts")).toBe(false)
  })

  test("survives a corrupt cache file by rebuilding from disk", async () => {
    const root = await fixture(TYPESCRIPT_FIXTURE)
    const cacheDirectory = await fixture({})
    await buildIndex(root, { cacheDirectory, coChange: false })

    for (const name of await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: cacheDirectory }))) {
      await writeFile(join(cacheDirectory, name), "{ truncated", "utf8")
    }
    clearIndexCache()
    const rebuilt = await refreshIndex(root, { cacheDirectory, coChange: false })
    expect(rebuilt.stats.parsedFiles).toBe(5)
    expect(rebuilt.files.length).toBe(5)
  })

  test("keeps the term table identical when a path or heading contains a space", async () => {
    // The cache encodes terms as a space separated "term count" list, so a term
    // holding a space used to shift every later pair and overwrite an unrelated
    // term with NaN, making a warm load retrieve differently from a cold build.
    const root = await fixture({
      "My Widgets/renderer.ts": `export function renderWidget() {\n  return 1\n}\n`,
      "docs/guide.md": `## Payment Gateway\n\nprose about billing and invoices\n`,
    })
    const cacheDirectory = await fixture({})
    const cold = await buildIndex(root, { cacheDirectory, coChange: false })
    clearIndexCache()
    const warm = await refreshIndex(root, { cacheDirectory, coChange: false })

    expect(warm.stats.reusedFiles).toBe(2)
    for (const file of cold.files) {
      expect([...warm.files.find((entry) => entry.path === file.path)!.tokens]).toEqual([...file.tokens])
    }
    expect(cold.files.flatMap((file) => [...file.tokens.keys()]).filter((term) => /\s/.test(term))).toEqual([])
    expect(warm.files.flatMap((file) => [...file.tokens.values()]).filter((count) => Number.isNaN(count))).toEqual([])
    expect(rankFiles(warm, "payment").map((file) => file.path)).toEqual(rankFiles(cold, "payment").map((file) => file.path))
    expect(rankFiles(warm, "widgets").some((file) => file.path === "My Widgets/renderer.ts")).toBe(true)
  })
})

describe("repo index git co-change", () => {
  test("scores files that history changed in the same commit", async () => {
    const root = await fixture({
      "src/alpha.ts": `export function computeTariff(units: number) {\n  return units * 3\n}\n`,
      "src/beta.ts": `export function renderWidget(label: string) {\n  return label.trim()\n}\n`,
    })
    await git(root, ["init", "-q"])
    await git(root, ["add", "-A"])
    await git(root, [
      "-c",
      "user.email=tests@vectordev.ai",
      "-c",
      "user.name=Vector Tests",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "initial",
    ])

    const index = await buildIndex(root)
    expect(index.head).not.toBe("")
    expect(index.coChange.get("src/alpha.ts")?.get("src/beta.ts")).toBe(1)

    // beta.ts shares no token with the query and no import edge with alpha.ts,
    // so history is the only thing that can surface it.
    const beta = rankFiles(index, "computeTariff").find((file) => file.path === "src/beta.ts")
    expect(beta).toBeDefined()
    expect(beta!.reasons.some((reason) => reason.startsWith("changed alongside src/alpha.ts in 1"))).toBe(true)
    expect(rankFiles(index, "computeTariff", { coChange: false }).some((file) => file.path === "src/beta.ts")).toBe(false)
  })
})

describe("repo index languages", () => {
  test("parses imports and symbols across languages", async () => {
    const root = await fixture({
      "pkg/__init__.py": "",
      "pkg/models.py": `class Invoice:\n    pass\n\n\ndef compute_total(rows):\n    return sum(rows)\n`,
      "pkg/service.py": `from .models import Invoice\nfrom pkg.models import compute_total\n`,
      "cmd/main.go": `package main\n\nimport (\n\t"fmt"\n\t"example.com/app/internal/store"\n)\n\nfunc main() {\n\tfmt.Println(store.SaveOrder)\n}\n`,
      "internal/store/store.go": `package store\n\ntype Order struct {\n\tID string\n}\n\nfunc SaveOrder(order Order) error {\n\treturn nil\n}\n\nfunc unexported() {}\n`,
      "src/lib.rs": `mod parser;\n\nuse crate::parser::Ast;\n\npub fn run() -> Ast {\n    parser::parse_ast()\n}\n`,
      "src/parser.rs": `pub struct Ast {\n    pub root: String,\n}\n\npub fn parse_ast() -> Ast {\n    Ast { root: String::new() }\n}\n`,
      "app/com/shop/Order.java": `package com.shop;\n\npublic class Order {\n  public String label() {\n    return "order";\n  }\n}\n`,
      "app/com/shop/Service.java": `package com.shop;\n\nimport com.shop.Order;\n\npublic class Service {\n}\n`,
      "lib/util.h": `typedef struct Buffer {\n  int size;\n} Buffer;\n`,
      "lib/util.c": `#include "util.h"\n\nint buffer_size(Buffer *buffer) {\n  return buffer->size;\n}\n`,
      "lib/parser.rb": `class DocumentParser\n  def parse_line(line)\n    line.strip\n  end\nend\n`,
      "lib/runner.rb": `require_relative "parser"\n\nclass Runner\nend\n`,
      "src/Domain/Invoice.php": `<?php\n\nclass Invoice\n{\n    public function total()\n    {\n        return 0;\n    }\n}\n`,
      "src/Domain/Billing.php": `<?php\n\nuse App\\Domain\\Invoice;\n\nclass Billing\n{\n}\n`,
    })
    const index = await buildIndex(root, { coChange: false })
    const dependencies = (path: string) => index.files.find((file) => file.path === path)!.dependencies
    const symbols = (path: string) => index.files.find((file) => file.path === path)!.symbols

    expect(dependencies("pkg/service.py")).toContain("pkg/models.py")
    expect(dependencies("cmd/main.go")).toContain("internal/store/store.go")
    expect(dependencies("src/lib.rs")).toContain("src/parser.rs")
    expect(dependencies("app/com/shop/Service.java")).toContain("app/com/shop/Order.java")
    expect(dependencies("lib/util.c")).toContain("lib/util.h")
    expect(dependencies("lib/runner.rb")).toContain("lib/parser.rb")
    expect(dependencies("src/Domain/Billing.php")).toContain("src/Domain/Invoice.php")

    expect(symbols("pkg/models.py")).toContainEqual({ name: "compute_total", kind: "function", line: 5, exported: true })
    expect(symbols("internal/store/store.go")).toContainEqual({ name: "SaveOrder", kind: "function", line: 7, exported: true })
    expect(symbols("internal/store/store.go").find((symbol) => symbol.name === "unexported")?.exported).toBe(false)
    expect(symbols("src/parser.rs").find((symbol) => symbol.name === "parse_ast")).toMatchObject({
      kind: "function",
      exported: true,
    })
    expect(symbols("lib/parser.rb").find((symbol) => symbol.name === "DocumentParser")?.kind).toBe("class")
    expect(symbols("src/Domain/Invoice.php").find((symbol) => symbol.name === "Invoice")?.kind).toBe("class")

    const ranked = rankFiles(index, "compute_total for an invoice")
    expect(ranked[0]!.path).toBe("pkg/models.py")
  })
})
