import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { BrainCode } from "@vectordevai/core/brain/code"
import {
  BrainAnchorTable,
  BrainCodeFileTable,
  BrainCodeLiteralTable,
  BrainCodeSymbolTable,
  BrainStateTable,
} from "@vectordevai/core/brain/sql"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

// The code index in core: the symbol, import and literal parsers the desktop's file ranking used, moved here and read
// the same way (the desktop's own tests run through them), and the code tables kept in step with a working tree,
// reading only what changed. Routes, environment variables and constants a document names are found in the tables.

describe("BrainCode parsers", () => {
  test("symbols, imports and the files they name across languages, as the desktop ranking reads them", () => {
    const files: Record<string, string> = {
      "src/billing/gateway.ts": `import { logger } from "../common/logging"\n\nexport class PaymentError extends Error {}\n\nexport const refundPolicy = { windowDays: 30 }\n\nexport function processPayment(amount: number) {\n  logger.info("processPayment starting")\n}\n`,
      "src/common/logging.ts": "export const logger = {\n  info(message: string) {\n    return message\n  },\n}\n",
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
    }
    const lookup = BrainCode.lookup(Object.keys(files))
    const read = (file: string) => {
      const language = BrainCode.language(file)!
      return {
        symbols: BrainCode.symbols(files[file]!, language),
        dependencies: BrainCode.dependencies(file, BrainCode.imports(files[file]!, language), language, lookup),
      }
    }
    expect(read("src/billing/gateway.ts").symbols).toEqual([
      { name: "PaymentError", kind: "class", line: 3, exported: true },
      { name: "refundPolicy", kind: "constant", line: 5, exported: true },
      { name: "processPayment", kind: "function", line: 7, exported: true },
    ])
    expect(read("src/billing/gateway.ts").dependencies).toEqual(["src/common/logging.ts"])
    expect(read("pkg/service.py").dependencies).toContain("pkg/models.py")
    expect(read("cmd/main.go").dependencies).toContain("internal/store/store.go")
    expect(read("src/lib.rs").dependencies).toContain("src/parser.rs")
    expect(read("app/com/shop/Service.java").dependencies).toContain("app/com/shop/Order.java")
    expect(read("lib/util.c").dependencies).toContain("lib/util.h")
    expect(read("lib/runner.rb").dependencies).toContain("lib/parser.rb")
    expect(read("src/Domain/Billing.php").dependencies).toContain("src/Domain/Invoice.php")
    expect(read("pkg/models.py").symbols).toContainEqual({ name: "compute_total", kind: "function", line: 5, exported: true })
    expect(read("internal/store/store.go").symbols).toContainEqual({ name: "SaveOrder", kind: "function", line: 7, exported: true })
    expect(read("internal/store/store.go").symbols.find((symbol) => symbol.name === "unexported")?.exported).toBe(false)
    expect(read("src/parser.rs").symbols.find((symbol) => symbol.name === "parse_ast")).toMatchObject({ kind: "function", exported: true })
    expect(read("lib/parser.rb").symbols.find((symbol) => symbol.name === "DocumentParser")?.kind).toBe("class")
  })

  test("routes of each framework, environment reads of each language, and constants with a plain value", () => {
    const code = [
      'router.get("/v1/users/:id", handler)',
      '@Post("/v1/invoices")',
      'export const create = HttpApiEndpoint.post("createSession", "/v2/sessions/{id}")',
      '@app.delete("/v1/uploads/<id>")',
      'mux.HandleFunc("GET /healthz", health)',
      'const url = "/v1/users/" + id',
      "const host = process.env.SMTP_HOST ?? Bun.env.SMTP_PORT",
      'const key = import.meta.env["VITE_KEY"] ?? Deno.env.get("DENO_TOKEN")',
      'bucket = os.environ["UPLOAD_BUCKET"] or os.getenv("REGION")',
      'let level = env::var("RUST_LOG")',
      "export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024",
      "export const greeting = hello()",
    ].join("\n")
    const literals = BrainCode.literals(code, BrainCode.symbols(code, "typescript"))
    expect(literals.filter((literal) => literal.kind === "route")).toEqual([
      { kind: "route", value: "/v1/users/*", method: "GET", line: 1 },
      { kind: "route", value: "/v1/invoices", method: "POST", line: 2 },
      { kind: "route", value: "/v2/sessions/*", method: "POST", line: 3 },
      { kind: "route", value: "/v1/uploads/*", method: "DELETE", line: 4 },
      { kind: "route", value: "/healthz", method: "GET", line: 5 },
    ])
    expect(literals.filter((literal) => literal.kind === "env").map((literal) => literal.value).toSorted()).toEqual([
      "DENO_TOKEN",
      "REGION",
      "RUST_LOG",
      "SMTP_HOST",
      "SMTP_PORT",
      "UPLOAD_BUCKET",
      "VITE_KEY",
    ])
    // A constant given by a call has no value to check.
    expect(literals.filter((literal) => literal.kind === "constant")).toEqual([
      { kind: "constant", value: "MAX_UPLOAD_BYTES", line: 11 },
    ])
  })

  test("history: files committed together, never in a wide commit, at most sixteen neighbours, only known files", () => {
    const hash = (n: number) => n.toString(16).padStart(40, "0")
    const wide = Array.from({ length: 40 }, (_, index) => `src/wide${index}.ts`)
    const many = Array.from({ length: 20 }, (_, index) => [hash(100 + index), "src/hub.ts", `src/spoke${index}.ts`])
    const log = [
      hash(1),
      "src/a.ts",
      "src/b.ts",
      "vendor/lib.ts",
      "",
      hash(2),
      "src/a.ts",
      "src/b.ts",
      hash(3),
      ...wide,
      ...many.flat(),
    ].join("\n")
    const history = BrainCode.coChange(log, (file) => (file.startsWith("src/") ? file : undefined))
    expect(history.pairs.get("src/a.ts")).toEqual(new Map([["src/b.ts", 2]]))
    expect(history.pairs.has("src/wide0.ts")).toBe(false)
    expect(history.pairs.get("src/hub.ts")?.size).toBe(BrainCode.LIMIT.neighbours)
    expect(history.commits).toBe(22)
  })

  test("what counts as code: by language, never dependencies or build output", () => {
    expect(BrainCode.language("src/a.ts")).toBe("typescript")
    expect(BrainCode.language("Dockerfile")).toBe("text")
    expect(BrainCode.language("assets/logo.png")).toBeUndefined()
    expect(BrainCode.excluded("node_modules/pkg/index.ts")).toBe(true)
    expect(BrainCode.excluded("packages/app/dist/bundle.js")).toBe(true)
    expect(BrainCode.excluded("src/dist.ts")).toBe(false)
  })
})

const filesOf = (setup: Setup) =>
  setup.db
    .select()
    .from(BrainCodeFileTable)
    .where(eq(BrainCodeFileTable.repository_id, setup.place.repository))
    .all()
    .pipe(Effect.orDie)

const revisionOf = (setup: Setup) =>
  setup.db
    .select({ code: BrainStateTable.code_revision })
    .from(BrainStateTable)
    .where(eq(BrainStateTable.repository_id, setup.place.repository))
    .get()
    .pipe(Effect.map((row) => row?.code ?? 0), Effect.orDie)

const write = (setup: Setup, file: string, body: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(path.join(setup.root, file)), { recursive: true })
    await fs.writeFile(path.join(setup.root, file), body)
  })

describe("BrainKnowledge.code", () => {
  test("reads the working tree once, then only what changed; removed files go; an arrived file resolves what named it", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          const first = yield* setup.knowledge.code(setup.place)
          const symbols = yield* setup.db.select().from(BrainCodeSymbolTable).all().pipe(Effect.orDie)
          const literals = yield* setup.db.select().from(BrainCodeLiteralTable).all().pipe(Effect.orDie)
          const revision = yield* revisionOf(setup)
          const again = yield* setup.knowledge.code(setup.place)
          const unchanged = yield* revisionOf(setup)
          yield* write(setup, "src/api/routes.ts", 'router.post("/v1/refunds", refund)\n')
          const edited = yield* setup.knowledge.code(setup.place)
          const routes = yield* setup.db
            .select({ value: BrainCodeLiteralTable.value })
            .from(BrainCodeLiteralTable)
            .where(eq(BrainCodeLiteralTable.kind, "route"))
            .all()
            .pipe(Effect.orDie)
          yield* Effect.promise(() => fs.rm(path.join(setup.root, "src/old.ts")))
          yield* write(setup, "src/later.ts", "export const later = 1\n")
          const moved = yield* setup.knowledge.code(setup.place)
          return {
            first,
            symbols,
            literals,
            revision,
            again,
            unchanged,
            edited,
            routes,
            moved,
            files: yield* filesOf(setup),
            gone: yield* setup.db
              .select()
              .from(BrainCodeSymbolTable)
              .where(eq(BrainCodeSymbolTable.path, "src/old.ts"))
              .all()
              .pipe(Effect.orDie),
          }
        }),
      {
        files: {
          "src/billing/invoice.ts": 'import { later } from "../later"\n\nexport function createInvoice(cents: number) {\n  return cents\n}\n',
          "src/api/routes.ts": 'router.get("/v1/users/:id", find)\n',
          "src/config.ts": "export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024\nexport const host = process.env.SMTP_HOST\n",
          "src/old.ts": "export function retired() {}\n",
          // Never read: a secret, dependencies, build output, and a document's code sample gives no route.
          ".env": "SECRET_TOKEN=abc\n",
          "node_modules/pkg/index.ts": "export function vendored() {}\n",
          "dist/bundle.js": "export function bundled() {}\n",
          "README.md": '# Notes\n\n```ts\nrouter.get("/v1/readme", handler)\n```\n',
        },
        git: true,
      },
    )
    expect(result.first).toMatchObject({ files: 5, parsed: 5, removed: 0 })
    expect(result.symbols).toContainEqual(
      expect.objectContaining({ path: "src/billing/invoice.ts", name: "createInvoice", kind: "function", line: 3, exported: true }),
    )
    expect(result.symbols.every((symbol) => /^[0-9a-f]{64}$/.test(symbol.signature_hash))).toBe(true)
    expect(result.literals.map((literal) => [literal.path, literal.kind, literal.value, literal.method]).toSorted()).toEqual([
      ["src/api/routes.ts", "route", "/v1/users/*", "GET"],
      ["src/config.ts", "constant", "MAX_UPLOAD_BYTES", null],
      ["src/config.ts", "env", "SMTP_HOST", null],
    ])
    // Unchanged: nothing read, nothing written, the code graph keeps its revision.
    expect(result.again).toMatchObject({ files: 5, parsed: 0, reused: 5, removed: 0 })
    expect(result.unchanged).toBe(result.revision)
    expect(result.edited).toMatchObject({ parsed: 1, reused: 4 })
    expect(result.routes).toEqual([{ value: "/v1/refunds" }])
    expect(result.moved).toMatchObject({ files: 5, parsed: 1, removed: 1 })
    expect(result.gone).toEqual([])
    const invoice = result.files.find((file) => file.path === "src/billing/invoice.ts")!
    // Its import named a file that was not there yet; it is now.
    expect(invoice.dependencies).toEqual(["src/later.ts"])
    expect(result.files.map((file) => file.path).toSorted()).toEqual([
      "README.md",
      "src/api/routes.ts",
      "src/billing/invoice.ts",
      "src/config.ts",
      "src/later.ts",
    ])
  }, 30_000)

  test("history is read from the commits, and outside a git working tree nothing is read", async () => {
    const history = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await Bun.$`git add -A`.cwd(setup.root).quiet()
            await Bun.$`git -c user.email=tests@vectordev.ai -c user.name=Vector -c commit.gpgsign=false commit -q -m pair`
              .cwd(setup.root)
              .quiet()
          })
          yield* setup.knowledge.code(setup.place)
          return yield* filesOf(setup)
        }),
      { files: { "src/a.ts": "export const a = 1\n", "src/b.ts": "export const b = 2\n" }, git: true },
    )
    expect(history.find((file) => file.path === "src/a.ts")?.co_change).toEqual({ "src/b.ts": 1 })
    const outside = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          return { indexed: yield* setup.knowledge.code(setup.place), files: yield* filesOf(setup) }
        }),
      { files: { "src/a.ts": "export const a = 1\n" } },
    )
    expect(outside.indexed.files).toBe(0)
    expect(outside.files).toEqual([])
  }, 30_000)

  test("a document's routes, environment variables and constants link through the code index, with no search for routes", async () => {
    const greps: string[] = []
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* added(
            setup,
            text(
              "Platform spec.md",
              [
                "# Platform spec",
                "",
                "## 1 Endpoints",
                "",
                "POST /v1/invoices creates an invoice and returns 201.",
                "",
                "## 2 Config",
                "",
                "The mail server comes from the environment variable SMTP_HOST.",
                "",
                "Uploads are limited to at most 50 MB per file by `MAX_UPLOAD_BYTES`.",
                "",
              ].join("\n"),
            ),
          )
          return yield* setup.db
            .select()
            .from(BrainAnchorTable)
            .where(eq(BrainAnchorTable.repository_id, setup.place.repository))
            .all()
            .pipe(Effect.orDie)
        }),
      {
        files: {
          "src/api/routes.ts": 'router.post("/v1/invoices", (request, response) => response.status(201).end())\n',
          "src/notify/email.ts": "const host = process.env.SMTP_HOST ?? 'localhost'\n",
          "src/upload/limits.ts": "export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024\n",
        },
        git: true,
        greps,
      },
    )
    expect(result).toContainEqual(
      expect.objectContaining({ path: "src/api/routes.ts", method: "route", symbol: "POST /v1/invoices", line: 1 }),
    )
    expect(result).toContainEqual(expect.objectContaining({ path: "src/notify/email.ts", method: "env", symbol: "SMTP_HOST" }))
    expect(result).toContainEqual(
      expect.objectContaining({
        path: "src/upload/limits.ts",
        method: "constant",
        symbol: "MAX_UPLOAD_BYTES",
        value: { raw: "64 * 1024 * 1024", value: 67108864, unit: "B" },
      }),
    )
    // Only identifiers are searched for, where they are defined and used; routes never are.
    expect(greps.length).toBeGreaterThan(0)
    expect(greps.every((pattern) => pattern.startsWith("\\b(?:"))).toBe(true)
  }, 30_000)

  test("a file that grows past what code is read at leaves the index", async () => {
    const result = await withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          yield* setup.knowledge.code(setup.place)
          yield* write(setup, "src/big.ts", `export const big = "${"x".repeat(BrainCode.LIMIT.bytes)}"\n`)
          const after = yield* setup.knowledge.code(setup.place)
          return {
            after,
            rows: yield* setup.db
              .select()
              .from(BrainCodeFileTable)
              .where(and(eq(BrainCodeFileTable.repository_id, setup.place.repository), eq(BrainCodeFileTable.path, "src/big.ts")))
              .all()
              .pipe(Effect.orDie),
          }
        }),
      { files: { "src/big.ts": "export const big = 1\n", "src/a.ts": "export const a = 1\n" }, git: true },
    )
    expect(result.after.removed).toBe(1)
    expect(result.rows).toEqual([])
  }, 30_000)
})
