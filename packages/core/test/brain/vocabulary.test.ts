import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BrainFuse } from "@vectordevai/core/brain/fuse"
import { BrainLexical } from "@vectordevai/core/brain/lexical"
import { added, text, withKnowledge, type Setup } from "./fixture/knowledge"

// House vocabulary: the repository's glossary and acronyms say which of its words name one thing, so a request in one
// wording finds what the documents say in the other.

const SPEC = `# Reliability spec

## Glossary

- SLO: service level objective.
- Tenant: a customer account with its own data, billing and settings.

## Availability

The service level objective for the API is 99.9% each month.

## Contracts

The service level agreement with customers promises credits after an outage.

## Dashboards

The SLO dashboard lives in the ops folder.
`

const ask = (setup: Setup, query: string) =>
  setup.knowledge.recall(setup.place, {
    query,
    files: [],
    tier: "standard",
    tight: false,
    personal: true,
    exclude: new Set(),
  })

describe("house vocabulary", () => {
  test("a term record's names become one word; a definition that is prose is not a name", () => {
    const words = BrainFuse.vocabulary(
      [
        { term: "SLO", aliases: [], definition: "service level objective" },
        { term: "SLO", aliases: ["Service Level Objective"], definition: "Service Level Objective" },
        { term: "Tenant", aliases: [], definition: "a customer account with its own data, billing and settings" },
      ],
      BrainLexical.terms,
    )
    expect(words).toEqual([
      { phrases: [["slo"], ["service", "level", "objective"]] },
      { phrases: [["slo"], ["service", "level", "objective"]] },
    ])
  })

  test("a query that names one wording searches the other at half weight", () => {
    const words = [{ phrases: [["slo"], ["service", "level", "objective"]] }]
    const query = BrainLexical.terms("what is our SLO")
    const expanded = BrainFuse.expand(query, words)
    expect(expanded.query.get("slo")).toBe(1)
    expect(expanded.query.get("service")).toBe(0.5)
    expect(expanded.query.get("objective")).toBe(0.5)
    expect(expanded.phrases).toEqual([["service", "level", "objective"]])
    // Every word of a wording counts as one term of the query; part of it counts for nothing.
    expect(BrainFuse.hits(["service", "level", "objective"], query, expanded.phrases)).toBe(1)
    expect(BrainFuse.hits(["service", "level"], query, expanded.phrases)).toBe(0)
    // A query that names neither is not expanded.
    expect(BrainFuse.expand(BrainLexical.terms("rotate the keys"), words).query.size).toBe(
      BrainLexical.terms("rotate the keys").size,
    )
  })

  test('"SLO" finds what the spec says about the service level objective, and not the service level agreement', async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Reliability spec.md", SPEC))
        const slo = yield* ask(setup, "what is our SLO?")
        const words = yield* ask(setup, "where is the service level objective dashboard?")
        const search = yield* setup.knowledge.search(setup.place, { query: "SLO", personal: true })
        return { slo, words, search }
      }),
    )
    expect(result.slo.text).toContain("99.9%")
    expect(result.slo.text).not.toContain("credits after an outage")
    // The other way round: the request's words find the line that only says "SLO".
    expect(result.words.text).toContain("SLO dashboard")
    expect(result.search.map((card) => card.text).join("\n")).toContain("99.9%")
  })

  test("without a glossary, an acronym finds only itself", async () => {
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        yield* added(setup, text("Reliability spec.md", SPEC.replace(/## Glossary[\s\S]*?(?=## Availability)/, "")))
        return yield* ask(setup, "what is our SLO?")
      }),
    )
    expect(result.text ?? "").not.toContain("99.9%")
  })
})
