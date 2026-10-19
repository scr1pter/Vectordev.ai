import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { BrainGraph } from "@vectordevai/core/brain/graph"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { added, text, withKnowledge } from "./fixture/knowledge"

// Personalized PageRank over the code graph: deterministic, local to what the request touches, and able to bring in a
// requirement of a file the request never opened, through an import, a commit or a symbol it names, with no word in
// common with the request. No seeds, or no words to ask with, bring nothing.

const both = (a: string, b: string, weight: number) => [
  { source: a, target: b, weight },
  { source: b, target: a, weight },
]

describe("BrainGraph.build", () => {
  test("rows by target in sorted node order; a link given twice is both together, never above 1; self-links drop", () => {
    const graph = BrainGraph.build([
      { source: "b", target: "a", weight: 0.5 },
      { source: "b", target: "a", weight: 0.5 },
      { source: "b", target: "c", weight: 2 },
      { source: "b", target: "b", weight: 1 },
      { source: "a", target: "c", weight: 0 },
    ])
    expect(graph.ids).toEqual(["a", "b", "c"])
    expect([...graph.offsets]).toEqual([0, 0, 2, 2])
    expect([...graph.targets]).toEqual([0, 2])
    expect([...graph.weights]).toEqual([0.75, 1])
    expect(graph.out[1]).toBeCloseTo(1.75)
  })
})

describe("BrainGraph.rank", () => {
  // A file a request edits, a requirement linked to it, a file it imports and that file's own requirement, and a
  // chain of files running away from them.
  const edges = [
    ...both("F:edited.ts", "r-own", 1),
    ...both("F:edited.ts", "F:imported.ts", 0.32),
    ...both("F:imported.ts", "r-imported", 1),
    ...both("F:imported.ts", "F:far1.ts", 0.32),
    ...both("F:far1.ts", "F:far2.ts", 0.32),
    ...both("F:far2.ts", "r-far", 1),
    ...both("F:alone.ts", "r-alone", 1),
  ]

  test("is the same whatever order the links came in, every time", () => {
    const seeds = new Map([["F:edited.ts", 1]])
    const first = BrainGraph.rank(BrainGraph.build(edges), seeds)
    const shuffled = BrainGraph.rank(BrainGraph.build(edges.toReversed()), seeds)
    expect([...shuffled]).toEqual([...first])
    expect([...BrainGraph.rank(BrainGraph.build(edges), seeds)]).toEqual([...first])
  })

  test("mass falls with each hop and stays within three hops; the seed's own requirement leads", () => {
    const mass = BrainGraph.rank(BrainGraph.build(edges), new Map([["F:edited.ts", 1]]))
    expect(mass.get("r-own")!).toBeGreaterThan(mass.get("r-imported")!)
    expect(mass.get("r-imported")!).toBeGreaterThanOrEqual(BrainGraph.MASS)
    // r-far is four hops away, past where the walk goes.
    expect(mass.has("r-far")).toBe(false)
    expect(mass.has("r-alone")).toBe(false)
    expect([...mass.values()].reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(1 + 1e-9)
  })

  test("no seeds, or seeds the graph does not have, give nothing; a file with no links keeps its mass", () => {
    const graph = BrainGraph.build(edges)
    expect(BrainGraph.rank(graph, new Map()).size).toBe(0)
    expect(BrainGraph.rank(graph, new Map([["F:unknown.ts", 1]])).size).toBe(0)
    // A link to itself is no link: the file is a node of its own, and the walk never leaves it.
    const lone = BrainGraph.build([...edges, { source: "F:lone.ts", target: "F:lone.ts", weight: 1 }])
    expect([...BrainGraph.rank(lone, new Map([["F:lone.ts", 1]]))]).toEqual([["F:lone.ts", 1]])
  })

  test("a file only read starts with less than one edited", () => {
    const graph = BrainGraph.build(edges)
    const edited = BrainGraph.rank(graph, new Map([["F:edited.ts", BrainFuse.SEED.edited]]))
    const read = BrainGraph.rank(graph, new Map([["F:edited.ts", BrainFuse.SEED.read]]))
    expect(read.get("r-own")!).toBeCloseTo(edited.get("r-own")! * BrainFuse.SEED.read)
  })
})

const SPEC = `# Billing spec

## 1 Invoices

\`createInvoice\` MUST store every amount in integer cents.

## 2 Ledger

Ledger pages are archived after a year.
`

const CODE = {
  "src/billing/invoice.ts": "export function createInvoice(amountCents: number) {\n  return { amountCents }\n}\n",
  // Imports the governed file and names its function once, so no document is linked to it.
  "src/checkout/cart.ts": [
    'import * as billing from "../billing/invoice"',
    "",
    "export function checkout(lines: readonly number[]) {",
    "  return billing.createInvoice(lines.reduce((sum, line) => sum + line, 0))",
    "}",
    "",
  ].join("\n"),
  // Shares nothing with the invoice code but history.
  "src/ledger/book.ts": "export const pages = new Map<string, number>()\n",
  "src/ui/theme.ts": "export const accent = '#7c3aed'\n",
}

const ask = (query: string, seeds?: readonly BrainFuse.Seed[]): Parameters<BrainKnowledge.Interface["recall"]>[1] => ({
  query,
  files: [],
  tier: "standard",
  tight: false,
  personal: true,
  exclude: new Set(),
  ...(seeds ? { seeds } : {}),
})

const commit = (root: string, files: readonly string[], message: string) =>
  Effect.promise(async () => {
    await Bun.$`git add ${files}`.cwd(root).quiet()
    await Bun.$`git -c user.email=tests@vectordev.ai -c user.name=Vector -c commit.gpgsign=false commit -q -m ${message}`
      .cwd(root)
      .quiet()
  })

describe("BrainKnowledge.recall through the code graph", () => {
  const recalls = (graph: "pagerank" | "activation") =>
    withKnowledge(
      (setup) =>
        Effect.gen(function* () {
          // theme.ts shares one commit with a file that imports the governed one: two weak ties, which bring nothing.
          yield* commit(setup.root, ["src/checkout/cart.ts", "src/ui/theme.ts"], "checkout")
          yield* commit(setup.root, ["src/billing/invoice.ts", "src/ledger/book.ts"], "ledger with invoices")
          yield* added(setup, text("Billing spec.md", SPEC))
          const record = (yield* setup.knowledge.records(setup.place, { personal: true })).records.find((item) =>
            item.quote.includes("createInvoice"),
          )!
          return {
            record,
            imported: yield* setup.knowledge.recall(
              setup.place,
              ask("add a discount line before paying", [{ path: "src/checkout/cart.ts", weight: BrainFuse.SEED.edited }]),
            ),
            history: yield* setup.knowledge.recall(
              setup.place,
              ask("count pages per month", [{ path: "src/ledger/book.ts", weight: BrainFuse.SEED.edited }]),
            ),
            named: yield* setup.knowledge.recall(
              setup.place,
              ask("make the purchase flow faster", [{ symbol: "checkout", weight: BrainFuse.SEED.symbol }]),
            ),
            unseeded: yield* setup.knowledge.recall(setup.place, ask("add a discount line before paying")),
            hi: yield* setup.knowledge.recall(
              setup.place,
              ask("hi", [{ path: "src/checkout/cart.ts", weight: BrainFuse.SEED.edited }]),
            ),
            elsewhere: yield* setup.knowledge.recall(
              setup.place,
              ask("make the corners rounder", [{ path: "src/ui/theme.ts", weight: BrainFuse.SEED.edited }]),
            ),
          }
        }),
      { files: CODE, git: true, graph },
    )

  test("a file the request edits brings the requirement of a file it imports, with no word in common", async () => {
    const result = await recalls("pagerank")
    expect(result.imported.cards).toContain(result.record.id)
    expect(result.imported.why[result.record.id]).toBe("anchor:src/billing/invoice.ts:definition")
    expect(result.imported.text).toContain("createInvoice MUST store every amount in integer cents.")
    // A file committed with the governed one, and a symbol the request names, reach it too.
    expect(result.history.cards).toContain(result.record.id)
    expect(result.named.cards).toContain(result.record.id)
    // Unrelated sections stay out.
    expect(result.imported.text).not.toContain("archived after a year")
    // No seeds, no words to ask with, or a file only weakly tied to the code, bring nothing.
    for (const nothing of [result.unseeded, result.hi, result.elsewhere]) {
      expect(nothing.tokens).toBe(0)
      expect(nothing.text ?? "").toBe("")
    }
  }, 30_000)

  test("spreading activation over code links reaches none of them", async () => {
    const result = await recalls("activation")
    for (const nothing of [result.imported, result.history, result.named]) expect(nothing.tokens).toBe(0)
  }, 30_000)
})
