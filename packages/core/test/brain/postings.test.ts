import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { BrainDatabase } from "@vectordevai/core/brain/database"
import { BrainLexical } from "@vectordevai/core/brain/lexical"
import {
  BrainDocumentTable,
  BrainItemTable,
  BrainPostingTable,
  BrainStateTable,
  BrainTermTable,
} from "@vectordevai/core/brain/sql"

// Memory entries and document lines sharing words in different measure, so idf, length and ties all matter.
const CORPUS = [
  "Run engine tests one file at a time from packages/engine.",
  "Refresh tokens expire after 14 days; the session refresh endpoint rotates them.",
  "Clients must wait Retry-After seconds after a 429 and retry at most 3 times.",
  "Upload at most 50 MB per file; larger uploads are refused with 413.",
  "The billing service retries failed invoices three times before alerting.",
  "Use bun, not npm, to install dependencies in this repository.",
  "Session tokens are stored in the session table and refreshed by the refresh worker.",
  "The upload worker streams files to object storage and retries on timeout.",
  "Typecheck from each package directory with bun typecheck.",
  "Retry budgets: retry once for reads, never for writes.",
  "Engine tests need the fake LLM server; never call a paid model in tests.",
  "Invoices are integer cents; the billing service never stores floats.",
]

const QUERIES = [
  "how long do refresh tokens last?",
  "retry after 429",
  "upload size limit",
  "run the engine tests",
  "billing invoices retry",
  "session refresh token rotation endpoint",
  "deploy the docs site",
]

// The corpus as `rank` reads it, with ids that sort as their item numbers do, so the two break ties the same way.
const documents = CORPUS.map((text, index) => ({
  id: `m${String(index + 1).padStart(2, "0")}`,
  terms: BrainLexical.terms(text),
}))
const length = (terms: ReadonlyMap<string, number>) => [...terms.values()].reduce((sum, count) => sum + count, 0)
const frequency = documents.reduce((counts, document) => {
  for (const term of document.terms.keys()) counts.set(term, (counts.get(term) ?? 0) + 1)
  return counts
}, new Map<string, number>())
// Every posting of every item, query terms or not: the ranking reads only the query's.
const postings = documents.flatMap((document, index) =>
  [...document.terms].map(([term, count]) => ({ item: index + 1, term, count, length: length(document.terms) })),
)
const average = documents.reduce((sum, document) => sum + length(document.terms), 0) / documents.length

const byId = (ranked: ReturnType<typeof BrainLexical.rankPostings>) =>
  ranked.map((item) => ({ id: documents[item.item - 1]?.id, score: item.score, matched: item.matched }))

describe("BrainLexical.rankPostings", () => {
  test("ranks a stored keyword index exactly as rank ranks the same corpus", () => {
    for (const text of QUERIES) {
      const query = BrainLexical.terms(text)
      const ranked = BrainLexical.rankPostings({ postings, total: documents.length, average, frequency, query })
      expect(byId(ranked)).toEqual(BrainLexical.rank(documents, query))
    }
    // The comparison is not vacuous: most queries find something, and one finds nothing at all.
    expect(QUERIES.filter((text) => BrainLexical.rank(documents, BrainLexical.terms(text)).length > 0)).toHaveLength(6)
  })

  test("a term weighs its value up to 1, so an added term at half weight adds half its score", () => {
    const rank = (query: ReadonlyMap<string, number>) =>
      BrainLexical.rankPostings({ postings, total: documents.length, average, frequency, query })
    const retry = rank(new Map([["retry", 1]]))
    const half = rank(new Map([["retry", 0.5]]))
    expect(half.map((item) => item.item)).toEqual(retry.map((item) => item.item))
    expect(half.map((item) => item.score)).toEqual(retry.map((item) => item.score / 2))
    // A word said twice in a request is one term, as rank reads it.
    expect(rank(new Map([["retry", 2]]))).toEqual(retry)
  })

  test("nothing to rank gives nothing", () => {
    const query = BrainLexical.terms("refresh tokens")
    expect(BrainLexical.rankPostings({ postings: [], total: 0, average: 0, frequency, query })).toEqual([])
    expect(
      BrainLexical.rankPostings({ postings, total: documents.length, average, frequency, query: new Map() }),
    ).toEqual([])
  })

  test("postings stored in brain.db rank as rank does, reading only the query's terms", async () => {
    const ranked = await Effect.runPromise(
      Effect.gen(function* () {
        const database = yield* BrainDatabase.Service
        const db = database.db
        const now = Date.now()
        yield* db
          .insert(BrainDocumentTable)
          .values({
            id: "d1a2b3",
            repository_id: "repo-1",
            lineage: "notes",
            ordinal: 1,
            name: "notes.md",
            title: "Notes",
            format: "markdown",
            origin: "upload",
            visibility: "repository",
            content_hash: "hash",
            bytes: 1,
            unread: [],
            status: "searchable",
            stats: {
              tokens: 0,
              read: 0,
              sections: 0,
              passages: 0,
              records: 0,
              kinds: {
                requirement: 0,
                constraint: 0,
                decision: 0,
                contract: 0,
                procedure: 0,
                term: 0,
                entity: 0,
                fact: 0,
                question: 0,
              },
              held: 0,
              linked: 0,
              embedded: 0,
            },
            warnings: [],
            extractor: 1,
            created_at: now,
            updated_at: now,
          })
          .run()
        yield* db
          .insert(BrainItemTable)
          .values(
            documents.map((document, index) => ({
              id: index + 1,
              repository_id: "repo-1",
              type: "passage" as const,
              ref: `p${document.id}`,
              document_id: "d1a2b3",
              visibility: "repository" as const,
              status: "active" as const,
              length: length(document.terms),
              confidence: 1,
            })),
          )
          .run()
        const terms = [...frequency.keys()]
        yield* db
          .insert(BrainTermTable)
          .values(
            terms.map((term, index) => ({
              id: index + 1,
              repository_id: "repo-1",
              term,
              df: frequency.get(term) ?? 0,
            })),
          )
          .run()
        yield* db
          .insert(BrainPostingTable)
          .values(
            postings.map((posting) => ({
              term: terms.indexOf(posting.term) + 1,
              item: posting.item,
              count: posting.count,
            })),
          )
          .run()
        yield* db
          .insert(BrainStateTable)
          .values({
            repository_id: "repo-1",
            items: documents.length,
            item_length_sum: documents.reduce((sum, document) => sum + length(document.terms), 0),
          })
          .run()
        const state = yield* db.get<{ items: number; item_length_sum: number }>(
          sql`SELECT items, item_length_sum FROM brain_state WHERE repository_id = 'repo-1'`,
        )
        return yield* Effect.forEach(QUERIES, (text) =>
          Effect.gen(function* () {
            const query = BrainLexical.terms(text)
            if (query.size === 0) return []
            const words = sql.join(
              [...query.keys()].map((term) => sql`${term}`),
              sql`, `,
            )
            const rows = yield* db.all<{ item: number; term: string; count: number; length: number; df: number }>(sql`
              SELECT p.item, t.term, p.count, i.length, t.df FROM brain_term t
              JOIN brain_posting p ON p.term = t.id JOIN brain_item i ON i.id = p.item
              WHERE t.repository_id = 'repo-1' AND t.term IN (${words}) AND i.status = 'active' AND i.hold_reason IS NULL
            `)
            return BrainLexical.rankPostings({
              postings: rows,
              total: state?.items ?? 0,
              average: (state?.item_length_sum ?? 0) / (state?.items ?? 1),
              frequency: new Map(rows.map((row) => [row.term, row.df])),
              query,
            })
          }),
        )
      }).pipe(Effect.provide(BrainDatabase.layerFor(":memory:"))),
    )
    expect(ranked.map(byId)).toEqual(QUERIES.map((text) => BrainLexical.rank(documents, BrainLexical.terms(text))))
  })
})
