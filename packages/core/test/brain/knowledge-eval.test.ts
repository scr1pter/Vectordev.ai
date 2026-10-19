import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { added, text, withKnowledge } from "./fixture/knowledge"

// The knowledge eval: five specs of a small repository and 50 requests. Forty are tasks with the files they touch,
// mostly in words the governing requirement never uses; ten ask about nothing the specs say. Code-anchored recall has
// to find the requirement for at least 80% of the tasks, at least 20 points more than keywords alone, and send nothing
// at all for the other ten.

const FIXTURE = path.join(import.meta.dir, "..", "fixtures", "knowledge")

type Case = {
  readonly query: string
  readonly seeds: readonly { readonly path: string; readonly how: "edited" | "read" }[]
  readonly expect?: string
}

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

describe("knowledge eval", () => {
  test("anchor recall@5 is at least 0.8, 0.2 above keywords alone, and irrelevant requests cost 0 tokens", async () => {
    const queries: { readonly working: readonly Case[]; readonly irrelevant: readonly Case[] } = await Bun.file(
      path.join(FIXTURE, "queries.json"),
    ).json()
    const documents = await files(path.join(FIXTURE, "documents"))
    expect(queries.working).toHaveLength(40)
    expect(queries.irrelevant).toHaveLength(10)
    expect(Object.keys(documents)).toHaveLength(5)
    const result = await withKnowledge(
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
              ...(seeded
                ? { seeds: item.seeds.map((seed) => ({ path: seed.path, weight: BrainFuse.SEED[seed.how] })) }
                : {}),
            })
          const working = yield* Effect.forEach(queries.working, (item) =>
            Effect.gen(function* () {
              const anchored = yield* recall(item, true)
              const lexical = yield* recall(item, false)
              return {
                query: item.query,
                anchored: (anchored.text ?? "").includes(item.expect!),
                lexical: (lexical.text ?? "").includes(item.expect!),
                cards: anchored.cards.length,
              }
            }),
          )
          const irrelevant = yield* Effect.forEach(queries.irrelevant, (item) => recall(item, true))
          return { working, irrelevant }
        }),
      { files: await files(path.join(FIXTURE, "repo")), git: true },
    )
    const anchored = result.working.filter((item) => item.anchored).length / result.working.length
    const lexical = result.working.filter((item) => item.lexical).length / result.working.length
    const cards = result.working.reduce((sum, item) => sum + item.cards, 0) / result.working.length
    const missed = result.working.filter((item) => !item.anchored).map((item) => item.query)
    console.log(
      `knowledge eval: anchor recall@5 ${anchored.toFixed(2)}, keywords alone ${lexical.toFixed(2)}, ${cards.toFixed(1)} cards a request${missed.length ? `; missed: ${missed.join(" | ")}` : ""}`,
    )
    expect(anchored).toBeGreaterThanOrEqual(0.8)
    expect(anchored - lexical).toBeGreaterThanOrEqual(0.2)
    expect(cards).toBeLessThanOrEqual(5)
    expect(result.irrelevant.map((item) => item.tokens)).toEqual(Array.from({ length: 10 }, () => 0))
  }, 60_000)
})
