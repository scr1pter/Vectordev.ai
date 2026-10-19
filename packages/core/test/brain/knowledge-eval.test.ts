import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { added, text, withKnowledge } from "./fixture/knowledge"

// The knowledge eval: five specs of a small repository and 58 requests. Forty are tasks with the files they touch,
// mostly in words the governing requirement never uses; eight edit a file that only imports the governed one; ten ask
// about nothing the specs say. Code-anchored recall has to find the requirement for at least 80% of the tasks, at least
// 20 points more than keywords alone, and send nothing at all for the other ten. The code graph (personalized PageRank)
// replaced spreading activation over code links only because it does at least as well on both sets of tasks.

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "knowledge")

type Case = {
  readonly query: string
  readonly seeds: readonly { readonly path: string; readonly how: "edited" | "read" }[]
  readonly expect?: string
}

type Queries = { readonly working: readonly Case[]; readonly hops: readonly Case[]; readonly irrelevant: readonly Case[] }

async function files(dir: string, base = dir): Promise<Record<string, string>> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return files(full, base)
      return { [path.relative(base, full).split(path.sep).join("/")]: await fs.readFile(full, "utf8") }
    }),
  )
  return Object.assign({}, ...nested)
}

async function evaluate(queries: Queries, graph: "pagerank" | "activation") {
  const documents = await files(path.join(FIXTURE, "documents"))
  return withKnowledge(
    (setup) =>
      Effect.gen(function* () {
        for (const [name, body] of Object.entries(documents)) yield* added(setup, text(name, body))
        // Light: a request's few best cards, about five of them.
        const recall = (item: Case, seeded: boolean) =>
          setup.knowledge.recall(setup.place, {
            query: item.query,
            files: [],
            tier: "light",
            tight: false,
            personal: true,
            exclude: new Set(),
            ...(seeded ? { seeds: item.seeds.map((seed) => ({ path: seed.path, weight: BrainFuse.SEED[seed.how] })) } : {}),
          })
        const score = (cases: readonly Case[]) =>
          Effect.forEach(cases, (item) =>
            Effect.gen(function* () {
              const anchored = yield* recall(item, true)
              const lexical = yield* recall(item, false)
              return {
                query: item.query,
                anchored: (anchored.text ?? "").includes(item.expect!),
                lexical: (lexical.text ?? "").includes(item.expect!),
                cards: anchored.cards.length,
                tokens: anchored.tokens,
              }
            }),
          )
        return {
          working: yield* score(queries.working),
          hops: yield* score(queries.hops),
          irrelevant: yield* Effect.forEach(queries.irrelevant, (item) => recall(item, true)),
        }
      }),
    { files: await files(path.join(FIXTURE, "repo")), git: true, graph },
  )
}

const share = (items: readonly { readonly anchored: boolean }[]) => items.filter((item) => item.anchored).length / items.length
const tokens = (items: readonly { readonly tokens: number }[]) => items.reduce((sum, item) => sum + item.tokens, 0) / items.length

describe("knowledge eval", () => {
  test("anchor recall@5 is at least 0.8, 0.2 above keywords alone, PageRank at least activation, and irrelevant requests cost 0 tokens", async () => {
    const queries: Queries = await Bun.file(path.join(FIXTURE, "queries.json")).json()
    expect(queries.working).toHaveLength(40)
    expect(queries.hops).toHaveLength(8)
    expect(queries.irrelevant).toHaveLength(10)
    expect(Object.keys(await files(path.join(FIXTURE, "documents")))).toHaveLength(5)
    const pagerank = await evaluate(queries, "pagerank")
    const activation = await evaluate(queries, "activation")
    const lexical = pagerank.working.filter((item) => item.lexical).length / pagerank.working.length
    const hopsLexical = pagerank.hops.filter((item) => item.lexical).length / pagerank.hops.length
    const cards = pagerank.working.reduce((sum, item) => sum + item.cards, 0) / pagerank.working.length
    const missed = [...pagerank.working, ...pagerank.hops].filter((item) => !item.anchored).map((item) => item.query)
    console.log(
      `knowledge eval: anchor recall@5 PageRank ${share(pagerank.working).toFixed(2)}, activation ${share(activation.working).toFixed(2)}, keywords alone ${lexical.toFixed(2)} (${pagerank.working.length} tasks); through an import PageRank ${share(pagerank.hops).toFixed(2)}, activation ${share(activation.hops).toFixed(2)}, keywords alone ${hopsLexical.toFixed(2)} (${pagerank.hops.length} tasks); ${cards.toFixed(1)} cards and ${tokens(pagerank.working).toFixed(0)} tokens a request (activation ${tokens(activation.working).toFixed(0)})${missed.length ? `; missed: ${missed.join(" | ")}` : ""}`,
    )
    expect(share(pagerank.working)).toBeGreaterThanOrEqual(0.8)
    expect(share(pagerank.working) - lexical).toBeGreaterThanOrEqual(0.2)
    expect(cards).toBeLessThanOrEqual(5)
    expect(share(pagerank.working)).toBeGreaterThanOrEqual(share(activation.working))
    expect(share(pagerank.hops)).toBeGreaterThanOrEqual(share(activation.hops))
    // What only the graph can reach: a requirement of a file the edited one imports.
    expect(share(pagerank.hops)).toBeGreaterThanOrEqual(0.75)
    for (const run of [pagerank, activation])
      expect(run.irrelevant.map((item) => item.tokens)).toEqual(Array.from({ length: 10 }, () => 0))
  }, 110_000)
})
